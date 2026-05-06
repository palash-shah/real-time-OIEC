"""
pick_short_ttr_markets.py — list Polymarket markets close to expiry.

Run from your venv:
    cd C:\\dev\\real-time-OIEC\\backend
    .\\venv\\Scripts\\Activate.ps1
    python pick_short_ttr_markets.py

Lists active, unresolved Polymarket contracts by days-to-resolution, filtered
to a minimum liquidity threshold so you don't end up tracking dead markets.

Output is a ranked table you can read top-to-bottom and pick from.
For each candidate it prints the event slug and the YES/NO outcome label, which
are exactly the two strings markets_config.py needs. Just paste the ones you
want to track into your existing MARKETS list.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from typing import Iterable
from urllib import request, parse, error


GAMMA_URL = "https://gamma-api.polymarket.com/markets"
EVENTS_URL = "https://gamma-api.polymarket.com/events"

# Polymarket's Gamma API sits behind Cloudflare and 403s plain urllib User-Agents.
# Pretending to be a normal browser is enough.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://polymarket.com",
    "Referer": "https://polymarket.com/",
}


def _http_get_json(url: str, timeout: int = 20) -> list | dict | None:
    """GET a JSON payload from the Gamma API with browser-style headers."""
    req = request.Request(url, headers=DEFAULT_HEADERS)
    try:
        with request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            body = ""
        print(f"[!] HTTP {e.code} from {url.split('?')[0]} {('— ' + body) if body else ''}")
        return None
    except error.URLError as e:
        print(f"[!] Network error: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"[!] JSON decode failed: {e}")
        return None


def fetch_markets(limit: int = 500) -> list[dict]:
    """Pull active, non-closed markets from the Gamma API.

    We DON'T pass `order=endDate&ascending=true` because Polymarket's market-level
    endDate field is unreliable — the script does its own days-to-resolution
    calculation client-side using the more accurate event endDate, then sorts.
    """
    out: list[dict] = []
    offset = 0
    page_size = 100
    while len(out) < limit:
        params = {
            "limit": str(min(page_size, limit - len(out))),
            "offset": str(offset),
            "active": "true",
            "closed": "false",
            "archived": "false",
        }
        url = f"{GAMMA_URL}?{parse.urlencode(params)}"
        page = _http_get_json(url)
        if not isinstance(page, list) or not page:
            break
        out.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return out


def days_to_resolution(market: dict, now: datetime) -> float | None:
    """Return days until market resolves, or None if missing/unparseable.

    Polymarket's `endDate` on the market itself is unreliable — many markets
    have an old endDate that was never updated to match the question's actual
    deadline. The parent event's endDate (in `events[0].endDate`) is more
    accurate. We try event first, then fall back to market.endDate, and
    reject anything in the past.
    """
    candidates = []

    # 1. Event endDate (most reliable)
    events = market.get("events") or []
    if isinstance(events, list) and events:
        ev_end = events[0].get("endDate") or events[0].get("end_date")
        if ev_end:
            candidates.append(ev_end)

    # 2. Market endDate (fallback)
    market_end = market.get("endDate") or market.get("end_date")
    if market_end:
        candidates.append(market_end)

    for end_iso in candidates:
        try:
            end = datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
        except Exception:
            continue
        delta = (end - now).total_seconds() / 86400.0
        if delta > 0:           # reject past dates
            return delta
    return None


def liquidity_of(market: dict) -> float:
    """Numeric liquidity if present, else 0.0."""
    for k in ("liquidityNum", "liquidity", "liquidity_num"):
        v = market.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                pass
    return 0.0


def volume_of(market: dict) -> float:
    for k in ("volumeNum", "volume", "volume_num"):
        v = market.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                pass
    return 0.0


def yes_outcome_label(market: dict) -> str:
    """Polymarket markets store outcomes as a list (e.g. ['Yes', 'No'] or
    candidate names). The poller's resolve() takes the YES-side label.
    For binary markets it's almost always 'Yes'."""
    outcomes = market.get("outcomes")
    if isinstance(outcomes, str):
        try:
            outcomes = json.loads(outcomes)
        except Exception:
            outcomes = None
    if isinstance(outcomes, list) and outcomes:
        return str(outcomes[0])
    return "Yes"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-days", type=float, default=30.0,
                    help="only show markets resolving within this many days (default 30)")
    ap.add_argument("--min-liq",  type=float, default=10000.0,
                    help="minimum liquidity to include (default $10k)")
    ap.add_argument("--limit",    type=int,   default=500,
                    help="how many active markets to scan (default 500)")
    ap.add_argument("--top",      type=int,   default=15,
                    help="how many candidates to print (default 15)")
    args = ap.parse_args()

    print(f"Fetching up to {args.limit} active Polymarket markets...")
    markets = fetch_markets(limit=args.limit)
    print(f"  got {len(markets)}")

    now = datetime.now(timezone.utc)
    candidates = []
    for m in markets:
        d = days_to_resolution(m, now)
        if d is None or d <= 0 or d > args.max_days:
            continue
        liq = liquidity_of(m)
        if liq < args.min_liq:
            continue

        # Extract event slug from nested events[] when available
        events = m.get("events") or []
        event_slug = ""
        event_title = ""
        if isinstance(events, list) and events:
            event_slug = events[0].get("slug") or ""
            event_title = events[0].get("title") or ""
        if not event_slug:
            event_slug = m.get("eventSlug") or m.get("event_slug") or m.get("slug") or ""

        # 24h volume — separates "trading right now" from "had volume months ago"
        vol_24h = 0.0
        for k in ("volume24hr", "volume24h", "volume_24h"):
            v = m.get(k)
            if isinstance(v, (int, float)):
                vol_24h = float(v); break
            if isinstance(v, str):
                try: vol_24h = float(v); break
                except ValueError: pass
        # Also check events[]
        if vol_24h == 0.0 and isinstance(events, list) and events:
            v = events[0].get("volume24hr") or events[0].get("volume24h")
            if isinstance(v, (int, float)):
                vol_24h = float(v)

        candidates.append({
            "days":   d,
            "liq":    liq,
            "vol":    volume_of(m),
            "vol_24h": vol_24h,
            "title":  (m.get("question") or m.get("title") or m.get("slug") or "—"),
            "slug":   m.get("slug") or "",
            "event_slug": event_slug,
            "event_title": event_title,
            "yes":    yes_outcome_label(m),
            "end":    m.get("endDate", "—"),
        })

    # Sort: recently traded first (24h volume), then days asc, then total liquidity
    candidates.sort(key=lambda c: (-c["vol_24h"], c["days"], -c["liq"]))
    candidates = candidates[:args.top]

    if not candidates:
        print("\nNo candidates found.")
        print("Try: --max-days 60 or --min-liq 1000")
        return

    print()
    print("=" * 110)
    print(f"  Top {len(candidates)} short-TTR candidates "
          f"(< {args.max_days:.0f}d to resolve, > ${args.min_liq:,.0f} liquidity, ranked by 24h volume)")
    print("=" * 110)
    print(f"  {'#':<3} {'Days':>5}  {'24h Vol':>11}  {'Liquidity':>11}  {'Total Vol':>13}  Title")
    print("  " + "-" * 106)
    for i, c in enumerate(candidates, 1):
        title = c["title"][:55]
        print(f"  {i:<3} {c['days']:>5.1f}  ${c['vol_24h']:>10,.0f}  ${c['liq']:>10,.0f}  ${c['vol']:>12,.0f}  {title}")

    print()
    print("=" * 110)
    print("  Suggested markets_config.py block (paste & adjust idx values to be unique)")
    print("=" * 110)
    print()
    for i, c in enumerate(candidates, 1):
        ttr_years = c["days"] / 365.25
        # Suggest tau as half the TTR, capped at 0.25 (3 months)
        tau_years = min(ttr_years * 0.5, 0.25)
        safe_name = c['title'].replace('"', "'")[:80]
        print(f"    OIECConfig(")
        print(f"        idx={100 + i},                              # change to a unique idx in your file")
        print(f"        name=\"{safe_name}\",")
        print(f"        primary=\"polymarket\",")
        print(f"        poly_slug=\"{c['event_slug']}\",       # event slug — verify at polymarket.com/event/<slug>")
        print(f"        poly_outcome=\"{c['yes']}\",")
        print(f"        kalshi_query=None,")
        print(f"        kalshi_ticker=None,")
        print(f"        ttr_years={ttr_years:.4f},          # ~{c['days']:.1f} days to resolution")
        print(f"        tau_years={tau_years:.4f},")
        print(f"        scheduled_events=[],")
        print(f"    ),")
    print()
    print("Done. Pick a few from the top of the list (highest 24h volume = actively traded).")
    print("Paste them into MARKETS in markets_config.py, comment out long-dated entries,")
    print("and restart main.py.")


if __name__ == "__main__":
    main()
