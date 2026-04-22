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
    # ===== POLITICS: LONG-DATED =====
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
    # 2. 2028 Presidential winner — JD Vance.
    OIECConfig(
        idx=1,
        name="JD Vance wins 2028 Presidency",
        poly_slug="presidential-election-winner-2028",
        poly_outcome="JD Vance",
        tau_years=0.33,
        ttr_years=2.55,
        primary="polymarket",
    ),
    # 3. Democratic Presidential Nominee 2028 — Newsom.
    OIECConfig(
        idx=2,
        name="Newsom — Democratic Presidential Nominee 2028",
        poly_slug="democratic-presidential-nominee-2028",
        poly_outcome="Gavin Newsom",
        tau_years=0.22,
        ttr_years=2.20,
        primary="polymarket",
    ),

    # ===== FED / RATES =====
    # 4. Fed decision — near-term
    OIECConfig(
        idx=3,
        name="Fed holds rates at April 2026 FOMC",
        poly_slug="fed-decision-in-april",
        poly_outcome="No change",
        tau_years=0.04,
        ttr_years=0.04,
        primary="polymarket",
    ),
    # 5. Zero Fed rate cuts in 2026
    OIECConfig(
        idx=4,
        name="Zero Fed rate cuts in 2026",
        poly_slug="how-many-fed-rate-cuts-in-2026",
        poly_outcome="0 (0 bps)",
        tau_years=0.15,
        ttr_years=0.70,
        primary="polymarket",
    ),
    # 6. One Fed rate cut in 2026
    OIECConfig(
        idx=5,
        name="One Fed rate cut in 2026",
        poly_slug="how-many-fed-rate-cuts-in-2026",
        poly_outcome="1 (25 bps)",
        tau_years=0.15,
        ttr_years=0.70,
        primary="polymarket",
    ),

    # ===== SPORTS =====
    # 7. NBA Champion 2026
    OIECConfig(
        idx=6,
        name="2026 NBA Champion — Boston Celtics",
        poly_slug="nba-champion-2026",
        poly_outcome="Boston Celtics",
        tau_years=0.08,
        ttr_years=0.20,
        primary="polymarket",
    ),

    # ===== SUPREME COURT / LONG-DATED =====
    # 8. SCOTUS vacancy in 2026
    OIECConfig(
        idx=7,
        name="Supreme Court vacancy in 2026",
        poly_slug="supreme-court-vacancy-in-2026",
        poly_outcome="Yes",
        tau_years=0.20,
        ttr_years=0.70,
        primary="polymarket",
    ),
]
