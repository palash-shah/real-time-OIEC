"""
build_config.py — generates a complete markets_config.py with verified
live-bindable Polymarket markets.

Improvements over v7:
  - VERIFIES each candidate against /events/slug/<slug> before including it,
    so we don't write configs that will fail to bind on backend startup.
  - Uses event.endDate (not market.endDate) for ttr_years - the same date
    field the rest of the dashboard reads, so the displayed days-to-resolution
    is consistent across the UI.
  - For multi-outcome events (e.g. Champions League with 8 candidates), picks
    only the single most-traded constituent - no duplicate event slugs.
  - Filters outcomes to exclude any that contain characters likely to break
    the resolver's exact-match logic.

Run from your venv:
    cd C:\\dev\\real-time-OIEC\\backend
    .\\venv\\Scripts\\Activate.ps1
    python build_config.py
    # -> writes markets_config.py.NEW; review and rename to markets_config.py
"""
import json
import time
from datetime import datetime, timezone
from urllib import request, parse, error

GAMMA_BASE = "https://gamma-api.polymarket.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":  "application/json, text/plain, */*",
    "Origin":  "https://polymarket.com",
    "Referer": "https://polymarket.com/",
}

# Cache: avoid re-fetching the same event multiple times
_event_cache: dict = {}


def _http_get(url: str, timeout: int = 15):
    req = request.Request(url, headers=HEADERS)
    try:
        with request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except (error.HTTPError, error.URLError, json.JSONDecodeError):
        return None


def fetch_markets_page(offset, limit=100):
    params = {
        "limit": str(limit),
        "offset": str(offset),
        "active": "true",
        "closed": "false",
        "archived": "false",
    }
    return _http_get(f"{GAMMA_BASE}/markets?{parse.urlencode(params)}") or []


def fetch_all_markets(target=2000):
    out = []
    offset = 0
    while len(out) < target:
        page = fetch_markets_page(offset)
        if not page:
            break
        out.extend(page)
        if len(page) < 100:
            break
        offset += 100
    return out


def fetch_event_by_slug(slug: str):
    """Fetch the full event payload from /events/slug/<slug>. Cached."""
    if slug in _event_cache:
        return _event_cache[slug]
    url = f"{GAMMA_BASE}/events/slug/{slug}"
    data = _http_get(url)
    _event_cache[slug] = data
    return data


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def event_end_date(m):
    events = m.get("events") or []
    if isinstance(events, list) and events:
        e = events[0].get("endDate") or events[0].get("end_date")
        if e:
            return e
    return m.get("endDate") or m.get("end_date")


def event_slug_of(m):
    events = m.get("events") or []
    if isinstance(events, list) and events:
        s = events[0].get("slug")
        if s:
            return s
    return m.get("eventSlug") or m.get("event_slug") or m.get("slug") or ""


def is_clean_label(s: str) -> bool:
    """Filter outcome labels likely to confuse the resolver's match logic."""
    if not isinstance(s, str) or not s:
        return False
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                  "0123456789 .,'-()&%/+")
    bad = [c for c in s if c not in allowed]
    return len(bad) == 0 and len(s) <= 60


def market_metrics(m, now):
    """Compute days-to-resolution + liquidity. Use event.endDate (the date
    the dashboard reads), not market.endDate."""
    end = parse_iso(event_end_date(m))
    if end is None:
        return None
    days = (end - now).total_seconds() / 86400
    if days <= 0:
        return None
    liq = float(m.get("liquidityNum") or 0)
    vol_24h = float(m.get("volume24hr") or 0)
    if vol_24h == 0:
        events = m.get("events") or []
        if events:
            vol_24h = float(events[0].get("volume24hr") or 0)
    return {"days": days, "liq": liq, "vol_24h": vol_24h}


def verify_event_binding(slug: str, expected_outcome: str):
    """Check the event exists at /events/slug/<slug> AND that
    expected_outcome appears as a sub-market title or outcome label."""
    ev = fetch_event_by_slug(slug)
    if not ev:
        return False, "event not found"
    if isinstance(ev, list):
        ev = ev[0] if ev else None
        if not ev:
            return False, "empty event response"
    if ev.get("closed") or not ev.get("active", True):
        return False, "event closed/inactive"
    sub = ev.get("markets") or []
    if not isinstance(sub, list) or not sub:
        return False, "no sub-markets"

    expected_lc = expected_outcome.lower().strip()
    for sm in sub:
        candidates = []
        for k in ("groupItemTitle", "title", "question"):
            if isinstance(sm.get(k), str):
                candidates.append(sm[k])
        outcomes = sm.get("outcomes")
        if isinstance(outcomes, str):
            try:
                outcomes = json.loads(outcomes)
            except Exception:
                outcomes = None
        if isinstance(outcomes, list):
            candidates.extend(str(o) for o in outcomes)
        for cand in candidates:
            if expected_lc in cand.lower() or cand.lower() in expected_lc:
                return True, f"matched on '{cand}'"
    return False, f"outcome {expected_outcome!r} not in event"


def best_outcome_for_market(m):
    """Pick the best outcome label for a single market m."""
    git = m.get("groupItemTitle")
    if isinstance(git, str) and is_clean_label(git):
        return git
    outcomes = m.get("outcomes")
    if isinstance(outcomes, str):
        try:
            outcomes = json.loads(outcomes)
        except Exception:
            outcomes = None
    if isinstance(outcomes, list) and outcomes:
        first = str(outcomes[0])
        if is_clean_label(first):
            return first
    return None


def select_for_tier(markets, now, day_min, day_max, liq_min, target_n,
                    seen_event_slugs):
    """Pick markets in window with liquidity floor, verifying each one."""
    candidates = []
    for m in markets:
        metrics = market_metrics(m, now)
        if metrics is None:
            continue
        if metrics["days"] < day_min or metrics["days"] >= day_max:
            continue
        if metrics["liq"] < liq_min:
            continue
        slug = event_slug_of(m)
        if not slug or slug in seen_event_slugs:
            continue

        outcome = best_outcome_for_market(m)
        if not outcome:
            continue

        ok, _msg = verify_event_binding(slug, outcome)
        time.sleep(0.05)  # courtesy delay
        if not ok:
            continue

        title = m.get("question") or m.get("title") or m.get("slug") or "—"
        candidates.append({
            "title": title,
            "event_slug": slug,
            "outcome": outcome,
            **metrics,
        })

    candidates.sort(key=lambda c: (-c["vol_24h"], -c["liq"]))

    picked = []
    for c in candidates:
        if c["event_slug"] in seen_event_slugs:
            continue
        seen_event_slugs.add(c["event_slug"])
        picked.append(c)
        if len(picked) >= target_n:
            break
    return picked


def render_oiec_block(c, idx):
    days = c["days"]
    ttr_years = days / 365.25
    tau_years = min(ttr_years * 0.5, 0.25)
    name = c["title"].replace('"', "'")[:90]
    return f'''    OIECConfig(
        idx={idx},
        name="{name}",
        primary="polymarket",
        poly_slug="{c['event_slug']}",
        poly_outcome="{c['outcome']}",
        kalshi_query=None,
        kalshi_ticker=None,
        ttr_years={ttr_years:.4f},          # ~{days:.1f} days, vol24h=${c['vol_24h']:,.0f}
        tau_years={tau_years:.4f},
        scheduled_events=[],
    ),'''


def main():
    now = datetime.now(timezone.utc)
    print(f"Fetching live Polymarket markets...")
    markets = fetch_all_markets(target=2000)
    print(f"  got {len(markets)}")
    print(f"  Verifying each candidate against live event endpoint...")
    print(f"  (this takes ~30s for the full pass)")
    print()

    seen: set = set()

    tier_a = select_for_tier(markets, now, 0, 14, 0, 8, seen)
    print(f"Tier A (<=14d eligible):   {len(tier_a)} markets verified")

    tier_b = select_for_tier(markets, now, 14, 30, 20_000, 8, seen)
    print(f"Tier B (14-30d near):      {len(tier_b)} markets verified")

    tier_c = select_for_tier(markets, now, 30, 90, 50_000, 8, seen)
    print(f"Tier C (30-90d mid):       {len(tier_c)} markets verified")

    print()
    total = len(tier_a) + len(tier_b) + len(tier_c)
    print(f"Total auto-discovered:     {total}")

    if total == 0:
        print("\nNo verified markets found. Polymarket API may be down or restructured.")
        return

    out = ['"""',
           'markets_config.py - auto-generated by build_config.py',
           '',
           f'Generated {now.isoformat()} from live Polymarket Gamma API.',
           f'  Tier A (<=14d, eligible): {len(tier_a)} markets',
           f'  Tier B (14-30d, near):    {len(tier_b)} markets',
           f'  Tier C (30-90d, mid):     {len(tier_c)} markets',
           '',
           "All markets verified against /events/slug/<slug> before inclusion -",
           "they should bind cleanly on backend startup. The 14-day eligibility",
           "threshold (set in pinning.py) means Tier A markets populate the",
           "GOF comparison; Tier B/C render as 'Calibrating'.",
           '"""',
           'from __future__ import annotations',
           'from dataclasses import dataclass, field',
           'from typing import Optional',
           '',
           '',
           '@dataclass',
           'class OIECConfig:',
           '    idx: int',
           '    name: str',
           '    poly_slug:     Optional[str] = None',
           '    poly_outcome:  str = "Yes"',
           '    kalshi_query:  Optional[str] = None',
           '    kalshi_ticker: Optional[str] = None',
           '    tau_years: float = 0.25',
           '    ttr_years: float = 1.0',
           '    primary: str = "polymarket"',
           '    scheduled_events: list[tuple[str, str]] = field(default_factory=list)',
           '',
           '',
           'MARKETS: list[OIECConfig] = [',
           '',
           '    # ============================================================',
           '    # TIER A - eligible markets (TTR <= 14 days)',
           '    # These will populate the GOF performance comparison.',
           '    # ============================================================',
           '']
    idx = 0
    for c in tier_a:
        out.append(render_oiec_block(c, idx))
        idx += 1
    out.extend(['',
                '    # ============================================================',
                '    # TIER B - near-resolution markets (14-30 days)',
                '    # ============================================================',
                ''])
    for c in tier_b:
        out.append(render_oiec_block(c, idx))
        idx += 1
    out.extend(['',
                '    # ============================================================',
                '    # TIER C - mid-horizon markets (30-90 days)',
                '    # ============================================================',
                ''])
    for c in tier_c:
        out.append(render_oiec_block(c, idx))
        idx += 1
    out.extend(['', ']', ''])

    with open("markets_config.py.NEW", "w", encoding="utf-8") as f:
        f.write("\n".join(out))

    print(f"\nWrote: markets_config.py.NEW   ({idx} markets)")
    print()
    print("To install:")
    print("  Move-Item -Force markets_config.py.NEW markets_config.py")
    print("  python main.py")
    print()
    print("Backend startup logs should show 'Polymarket bound' for each market.")
    print("If any fail to bind, paste the names - the verification step missed.")


if __name__ == "__main__":
    main()
