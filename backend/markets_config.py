"""
markets_config.py — which markets to monitor.

Each OIECConfig declares a search query AND a fallback slug. The poller
tries the search first (which survives slug renames) then falls through
to the direct slug lookup if search returns no matches.

All slugs below verified live on Polymarket as of April 2026. You can
re-verify any of them by pasting after "polymarket.com/event/".

To add a market: append an OIECConfig entry below, push to the repo,
and Render will redeploy.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class OIECConfig:
    idx: int
    name: str

    # Polymarket
    poly_query:    Optional[str] = None     # search query (preferred — survives slug rename)
    poly_slug:     Optional[str] = None     # fallback direct slug
    poly_outcome:  str = "Yes"              # which outcome within the market to bind to

    # Kalshi
    kalshi_query:  Optional[str] = None
    kalshi_ticker: Optional[str] = None

    # OIEC derivative parameters
    tau_years: float = 0.25
    ttr_years: float = 1.0

    primary: str = "polymarket"
    scheduled_events: list[tuple[str, str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.primary not in ("polymarket", "kalshi"):
            raise ValueError(f"primary must be polymarket|kalshi, got {self.primary!r}")
        if not (self.poly_query or self.poly_slug or self.kalshi_ticker or self.kalshi_query):
            raise ValueError(f"market {self.name!r}: at least one venue required")


MARKETS: list[OIECConfig] = [
    # 1. The headline: 2028 Presidential — which party wins?
    #    Slug verified April 2026. Democratic ~61¢, Republican ~39¢. $547M volume.
    OIECConfig(
        idx=0,
        name="2028 US Presidential — Democratic party wins",
        poly_query="2028 presidential party",
        poly_slug="which-party-wins-2028-us-presidential-election",
        poly_outcome="Democratic",
        kalshi_query="PRES28",
        tau_years=0.25,
        ttr_years=2.55,
        primary="polymarket",
    ),

    # 2. Fed decision in June 2026 — "No change" outcome. 5-way market at ~94%.
    #    Short horizon, frequent ticks, good diversity with the longer-dated election.
    OIECConfig(
        idx=1,
        name="Fed holds rates at June 2026 FOMC",
        poly_query="fed decision june 2026",
        poly_slug="fed-decision-in-june-825",
        poly_outcome="No change",
        kalshi_query="FED",
        tau_years=0.08,
        ttr_years=0.15,
        primary="polymarket",
    ),

    # 3. JD Vance wins presidency 2028 — single-candidate contract, ~24¢.
    #    From the presidential-election-winner-2028 market (36 outcomes).
    OIECConfig(
        idx=2,
        name="JD Vance wins 2028 Presidency",
        poly_query="presidential election winner 2028",
        poly_slug="presidential-election-winner-2028",
        poly_outcome="JD Vance",
        tau_years=0.33,
        ttr_years=2.55,
        primary="polymarket",
    ),

    # 4. Newsom is Democratic nominee 2028. $1.08B volume, ~27¢.
    OIECConfig(
        idx=3,
        name="Newsom — Democratic Presidential Nominee 2028",
        poly_query="democratic presidential nominee 2028",
        poly_slug="democratic-presidential-nominee-2028",
        poly_outcome="Gavin Newsom",
        tau_years=0.22,
        ttr_years=2.20,
        primary="polymarket",
    ),
]
