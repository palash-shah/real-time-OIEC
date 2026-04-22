"""
markets_config.py — which markets to monitor.

Each OIECConfig declares:
  - poly_slug: the EVENT slug from polymarket.com/event/<slug>
  - poly_outcome: the specific option within that event
      (e.g. "Democratic" within the party-wins event,
       "No change" within the Fed decision event,
       "JD Vance" within the candidate event)

The resolver fetches the event, finds the sub-market whose option label
matches poly_outcome, and binds to its conditionId. All quotes thereafter
use conditionId, which is stable across slug changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class OIECConfig:
    idx: int
    name: str

    poly_slug:     Optional[str] = None
    poly_outcome:  str = "Yes"

    kalshi_query:  Optional[str] = None
    kalshi_ticker: Optional[str] = None

    tau_years: float = 0.25
    ttr_years: float = 1.0

    primary: str = "polymarket"
    scheduled_events: list[tuple[str, str]] = field(default_factory=list)


MARKETS: list[OIECConfig] = [
    # 1. 2028 US Presidential — which party wins? Democrat outcome.
    OIECConfig(
        idx=0,
        name="2028 US Presidential — Democratic party wins",
        poly_slug="which-party-wins-2028-us-presidential-election",
        poly_outcome="Democratic",
        tau_years=0.25,
        ttr_years=2.55,
        primary="polymarket",
    ),
    # 2. Fed decision in June 2026 — No change outcome.
    OIECConfig(
        idx=1,
        name="Fed holds rates at June 2026 FOMC",
        poly_slug="fed-decision-in-june-825",
        poly_outcome="No change",
        tau_years=0.08,
        ttr_years=0.15,
        primary="polymarket",
    ),
    # 3. 2028 Presidential winner — JD Vance.
    OIECConfig(
        idx=2,
        name="JD Vance wins 2028 Presidency",
        poly_slug="presidential-election-winner-2028",
        poly_outcome="JD Vance",
        tau_years=0.33,
        ttr_years=2.55,
        primary="polymarket",
    ),
    # 4. Democratic Presidential Nominee 2028 — Newsom.
    OIECConfig(
        idx=3,
        name="Newsom — Democratic Presidential Nominee 2028",
        poly_slug="democratic-presidential-nominee-2028",
        poly_outcome="Gavin Newsom",
        tau_years=0.22,
        ttr_years=2.20,
        primary="polymarket",
    ),
]
