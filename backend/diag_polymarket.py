"""
diag_polymarket.py — print raw Polymarket Gamma API response so we can see
why pick_short_ttr_markets.py is rejecting everything.

Run from your venv:
    python diag_polymarket.py
"""
import json
from datetime import datetime, timezone
from urllib import request, parse, error

GAMMA_URL = "https://gamma-api.polymarket.com/markets"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Origin":  "https://polymarket.com",
    "Referer": "https://polymarket.com/",
}


def fetch(params):
    url = f"{GAMMA_URL}?{parse.urlencode(params)}"
    req = request.Request(url, headers=HEADERS)
    with request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    now = datetime.now(timezone.utc)
    print(f"Now (UTC): {now.isoformat()}")
    print()

    # ---------- TEST 1: what the script asks for ----------
    print("=" * 80)
    print("TEST 1: same query as pick_short_ttr_markets.py uses")
    print("=" * 80)
    params = {
        "limit": "10",
        "offset": "0",
        "active": "true",
        "closed": "false",
        "archived": "false",
        "order": "endDate",
        "ascending": "true",
    }
    print(f"  {GAMMA_URL}?{parse.urlencode(params)}")
    try:
        page = fetch(params)
    except Exception as e:
        print(f"  ERROR: {e}")
        return

    print(f"  Returned {len(page) if isinstance(page, list) else type(page).__name__}")
    print()
    if not isinstance(page, list) or not page:
        print("  Empty response. Try a different filter.")
        return

    # Show what fields a market actually has
    m0 = page[0]
    print("First market — ALL keys:")
    for k in sorted(m0.keys()):
        v = m0[k]
        if isinstance(v, str) and len(v) > 100:
            v = v[:100] + "..."
        print(f"    {k!r}: {v!r}")
    print()

    # Show date-relevant fields specifically
    print("First 10 markets — date / liquidity fields:")
    for i, m in enumerate(page[:10], 1):
        title = (m.get('question') or m.get('title') or m.get('slug') or '?')[:55]
        end = m.get('endDate') or m.get('end_date') or '—'
        active = m.get('active')
        closed = m.get('closed')
        liq = (m.get('liquidityNum') or m.get('liquidity') or 0)
        vol = (m.get('volumeNum') or m.get('volume') or 0)
        try:
            end_dt = datetime.fromisoformat(str(end).replace('Z', '+00:00'))
            days = (end_dt - now).total_seconds() / 86400
            days_str = f"{days:+8.2f}d"
        except Exception:
            days_str = "  parse-fail"
        print(f"    {i:2d}. active={active!s:5s} closed={closed!s:5s} {days_str}  liq=${liq}  vol=${vol}  {title}")

    # ---------- TEST 2: simpler query — just sort by volume ----------
    print()
    print("=" * 80)
    print("TEST 2: simpler query, sorted by volume (no date order)")
    print("=" * 80)
    params2 = {"limit": "10", "active": "true", "closed": "false"}
    page2 = fetch(params2)
    print(f"  Returned {len(page2)} markets")
    for i, m in enumerate(page2[:10], 1):
        title = (m.get('question') or m.get('title') or m.get('slug') or '?')[:55]
        end = m.get('endDate') or '—'
        try:
            end_dt = datetime.fromisoformat(str(end).replace('Z', '+00:00'))
            days = (end_dt - now).total_seconds() / 86400
            days_str = f"{days:+8.1f}d"
        except Exception:
            days_str = "  parse-fail"
        liq = m.get('liquidityNum') or 0
        vol = m.get('volumeNum') or 0
        print(f"    {i:2d}. {days_str} liq=${liq} vol=${vol}  {title}")

    # ---------- TEST 3: brute force — fetch all ~500 and tally days ----------
    print()
    print("=" * 80)
    print("TEST 3: full scan — count markets by days-to-resolution bucket")
    print("=" * 80)
    all_markets = []
    offset = 0
    while len(all_markets) < 500:
        page = fetch({"limit": "100", "offset": str(offset), "active": "true", "closed": "false"})
        if not isinstance(page, list) or not page:
            break
        all_markets.extend(page)
        if len(page) < 100:
            break
        offset += 100

    print(f"  Fetched {len(all_markets)} active+open markets")
    buckets = {"<7d": 0, "7-30d": 0, "30-90d": 0, "90-365d": 0, ">1y": 0, "no_date": 0, "past": 0}
    soonest = []
    for m in all_markets:
        end = m.get('endDate')
        if not end:
            buckets["no_date"] += 1
            continue
        try:
            end_dt = datetime.fromisoformat(str(end).replace('Z', '+00:00'))
            days = (end_dt - now).total_seconds() / 86400
        except Exception:
            buckets["no_date"] += 1
            continue
        if days < 0:
            buckets["past"] += 1
        elif days < 7:    buckets["<7d"] += 1
        elif days < 30:   buckets["7-30d"] += 1
        elif days < 90:   buckets["30-90d"] += 1
        elif days < 365:  buckets["90-365d"] += 1
        else:             buckets[">1y"] += 1
        soonest.append((days, m))
    soonest.sort(key=lambda x: x[0])
    print(f"  Distribution of days-to-resolution:")
    for k, v in buckets.items():
        print(f"    {k:10s}: {v}")
    print()
    print(f"  Soonest 10 markets (regardless of liquidity):")
    for days, m in soonest[:10]:
        title = (m.get('question') or m.get('title') or m.get('slug') or '?')[:55]
        liq = m.get('liquidityNum') or 0
        vol = m.get('volumeNum') or 0
        active = m.get('active')
        closed = m.get('closed')
        slug = m.get('slug', '?')
        print(f"    {days:+8.2f}d  active={active!s:5s} closed={closed!s:5s} liq=${liq} vol=${vol}")
        print(f"             slug={slug!r}")
        print(f"             title={title}")


if __name__ == "__main__":
    main()
