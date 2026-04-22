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
    # 4. Republican Presidential Nominee 2028 — JD Vance (same event, different outcome)
    OIECConfig(
        idx=3,
        name="JD Vance — Republican Presidential Nominee 2028",
        poly_slug="republican-presidential-nominee-2028",
        poly_outcome="JD Vance",
        tau_years=0.22,
        ttr_years=2.20,
        primary="polymarket",
    ),

    # ===== FED / RATES: SHORT-DATED =====
    # 5. Fed decision — No change outcome (near-term)
    OIECConfig(
        idx=4,
        name="Fed holds rates at April 2026 FOMC",
        poly_slug="fed-decision-in-april",
        poly_outcome="No change",
        tau_years=0.04,
        ttr_years=0.04,
        primary="polymarket",
    ),
    # 6. How many Fed rate cuts in 2026 — zero cuts
    OIECConfig(
        idx=5,
        name="Zero Fed rate cuts in 2026",
        poly_slug="how-many-fed-rate-cuts-in-2026",
        poly_outcome="0 (0 bps)",
        tau_years=0.15,
        ttr_years=0.70,
        primary="polymarket",
    ),
    # 7. How many Fed rate cuts in 2026 — one cut
    OIECConfig(
        idx=6,
        name="One Fed rate cut in 2026",
        poly_slug="how-many-fed-rate-cuts-in-2026",
        poly_outcome="1 (25 bps)",
        tau_years=0.15,
        ttr_years=0.70,
        primary="polymarket",
    ),

    # ===== CRYPTO: MEDIUM-DATED =====
    # 8. Bitcoin price target for the year
    OIECConfig(
        idx=7,
        name="Bitcoin reaches $150k in 2026",
        poly_slug="when-will-bitcoin-hit-150k",
        poly_outcome="By Dec 31",
        tau_years=0.15,
        ttr_years=0.70,
        primary="polymarket",
    ),

    # ===== GEOPOLITICS =====
    # 9. Iran / Israel conflict resolution
    OIECConfig(
        idx=8,
        name="Iran × Israel conflict ends by end of 2026",
        poly_slug="iran-israel-conflict-ends-by",
        poly_outcome="Dec 31",
        tau_years=0.20,
        ttr_years=0.70,
        primary="polymarket",
    ),

    # ===== SPORTS (broad appeal for demo) =====
    # 10. NBA Champion 2026
    OIECConfig(
        idx=9,
        name="2026 NBA Champion — Boston Celtics",
        poly_slug="nba-champion-2026",
        poly_outcome="Boston Celtics",
        tau_years=0.08,
        ttr_years=0.20,
        primary="polymarket",
    ),
    # 11. FIFA World Cup 2026
    OIECConfig(
        idx=10,
        name="2026 FIFA World Cup Winner — Spain",
        poly_slug="fifa-world-cup-2026-winner",
        poly_outcome="Spain",
        tau_years=0.12,
        ttr_years=0.30,
        primary="polymarket",
    ),

    # ===== SUPREME COURT / LONG-DATED =====
    # 12. SCOTUS vacancy in 2026
    OIECConfig(
        idx=11,
        name="Supreme Court vacancy in 2026",
        poly_slug="supreme-court-vacancy-in-2026",
        poly_outcome="Yes",
        tau_years=0.20,
        ttr_years=0.70,
        primary="polymarket",
    ),
]
