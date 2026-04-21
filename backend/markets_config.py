"""
markets_config.py — which markets to monitor.

Each OIECConfig ties together:
  - a display name (what shows in the dashboard)
  - a Polymarket slug (optional)
  - a Kalshi ticker (optional)
  - the OIEC derivative's horizon (tau) — the nearest expiry in years
  - the underlying event's time-to-resolution
  - the Polymarket slug or Kalshi ticker used as the *primary* price source

At least one venue must be configured. If both are, the cross-venue spread
is computed as the headline arbitrage metric.

The configured slugs/tickers here are best-guess defaults; the poller logs a
warning if a slug doesn't resolve on Polymarket or a ticker is unknown on
Kalshi, and will fall back to whichever venue does respond.

To add a market: append an OIECConfig entry below. Reload the server.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class OIECConfig:
    idx: int                       # display order
    name: str                      # human-readable label
    polymarket_slug: Optional[str]
    kalshi_ticker: Optional[str]
    tau_years: float               # nearest OIEC expiry, in years
    ttr_years: float               # underlying event time-to-resolution
    primary: str = "polymarket"    # which venue is the authoritative spot price
    scheduled_events: list[tuple[str, str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.primary not in ("polymarket", "kalshi"):
            raise ValueError(f"primary must be polymarket|kalshi, got {self.primary!r}")
        if not (self.polymarket_slug or self.kalshi_ticker):
            raise ValueError(f"market {self.name!r}: at least one venue required")
        if self.primary == "polymarket" and not self.polymarket_slug:
            raise ValueError(f"market {self.name!r}: primary=polymarket but no slug")
        if self.primary == "kalshi" and not self.kalshi_ticker:
            raise ValueError(f"market {self.name!r}: primary=kalshi but no ticker")


# IMPORTANT: these slugs/tickers are the *shape* of what to monitor.
# The exact slug/ticker strings drift as markets resolve and relist. The
# poller's bootstrap step searches for the closest live market and updates
# these in-memory. If a search returns nothing, the market is skipped and
# the dashboard will display just the other markets.
MARKETS: list[OIECConfig] = [
    OIECConfig(
        idx=0,
        name="2028 US Presidential — Democrat wins",
        polymarket_slug="will-a-democrat-win-the-2028-us-presidential-election",
        kalshi_ticker="KXPRES28-DEM",
        tau_years=0.25,
        ttr_years=2.60,
        primary="polymarket",
    ),
    OIECConfig(
        idx=1,
        name="Fed cuts at next FOMC",
        polymarket_slug="fed-interest-rate-decision",
        kalshi_ticker="KXFEDDECISION-26JUN-CUT",
        tau_years=0.08,
        ttr_years=0.12,
        primary="kalshi",
    ),
    OIECConfig(
        idx=2,
        name="Bitcoin above $150K in 2026",
        polymarket_slug="will-bitcoin-reach-150000-in-2026",
        kalshi_ticker="KXBTC-26DEC-150000",
        tau_years=0.17,
        ttr_years=0.64,
        primary="polymarket",
    ),
    OIECConfig(
        idx=3,
        name="US recession in 2026",
        polymarket_slug="us-recession-in-2026",
        kalshi_ticker="KXRECSSN-26",
        tau_years=0.22,
        ttr_years=0.88,
        primary="polymarket",
    ),
]
