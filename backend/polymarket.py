"""
polymarket.py — Polymarket Gamma API client.

Data model (verified against docs, April 2026):
  - An EVENT is a top-level question. Slug e.g. "which-party-wins-2028-us-presidential-election".
  - An event contains one or more MARKETS. Each market is a Yes/No question.
    - "Single-outcome" events (e.g. "Fed rate cut by June?") have 1 market
      with outcomes ["Yes", "No"].
    - "Multi-outcome" events (e.g. "Which party wins?") have N markets, one
      per option. The Democratic sub-market asks "Will Democratic win?",
      the Republican sub-market asks "Will Republican win?", etc. Each
      sub-market has outcomes ["Yes", "No"] and outcomePrices like ["0.61","0.39"].

To bind to a specific option you resolve the event, walk its `markets` array,
match on `groupItemTitle` (the option label — "Democratic", "JD Vance", etc.)
or fall back to `question`, then quote that sub-market's Yes price every tick.

API surface:
    resolve(event_slug, outcome_label) -> PolymarketBinding
    quote(binding) -> PolymarketQuote
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Optional

import httpx

log = logging.getLogger(__name__)

GAMMA_BASE = "https://gamma-api.polymarket.com"


@dataclass
class PolymarketBinding:
    event_slug:    str
    event_title:   str
    outcome_label: str           # what the user asked for ("Democratic")
    sub_market_title: str        # the actual sub-market title we matched
    condition_id:  str           # conditionId of the sub-market, stable
    sub_market_slug: str         # slug of the sub-market, for debugging


@dataclass
class PolymarketQuote:
    binding:     PolymarketBinding
    yes_price:   float           # YES price of the bound sub-market, [0, 1]
    volume:      float
    timestamp_s: float
    raw:         dict


class PolymarketClient:
    def __init__(self, timeout: float = 10.0) -> None:
        self._client = httpx.AsyncClient(timeout=timeout, headers={
            "User-Agent": "OIEC-Demo/0.1 (research)",
            "Accept": "application/json",
        })

    async def close(self) -> None:
        await self._client.aclose()

    # ---------- resolve ----------

    async def resolve(
        self,
        event_slug: str,
        outcome_label: str = "Yes",
    ) -> Optional[PolymarketBinding]:
        """Fetch the event, find the sub-market matching `outcome_label`,
        return a binding to that sub-market."""
        event = await self._fetch_event_by_slug(event_slug)
        if event is None:
            log.warning("Polymarket resolve: event slug %r not found", event_slug)
            return None

        event_title = event.get("title") or event.get("question") or event_slug
        markets = event.get("markets") or []
        if not markets:
            log.warning("Polymarket resolve: event %r has no markets", event_slug)
            return None

        # If there's only one sub-market, it's a plain Yes/No event. The
        # caller probably wants "Yes" regardless of what they passed.
        if len(markets) == 1:
            m = markets[0]
            if m.get("closed"):
                log.warning("Polymarket resolve: %r sole sub-market is closed", event_slug)
                return None
            return PolymarketBinding(
                event_slug=event_slug,
                event_title=event_title,
                outcome_label=outcome_label,
                sub_market_title=m.get("groupItemTitle") or m.get("question") or "",
                condition_id=m.get("conditionId") or "",
                sub_market_slug=m.get("slug", ""),
            )

        # Multi-outcome: match on groupItemTitle (option name) preferred,
        # then fall back to question (full sub-market question).
        target = outcome_label.strip().lower()
        best = None
        for m in markets:
            if m.get("closed"):
                continue
            title = (m.get("groupItemTitle") or "").strip()
            question = (m.get("question") or "").strip()
            if title.lower() == target:
                best = (100, m); break
            if title.lower().startswith(target) or target.startswith(title.lower()):
                if not best or best[0] < 80: best = (80, m)
            elif target in title.lower() or (title and title.lower() in target):
                if not best or best[0] < 60: best = (60, m)
            elif target in question.lower():
                if not best or best[0] < 40: best = (40, m)

        if not best:
            labels = [(m.get("groupItemTitle") or m.get("question") or "")[:60] for m in markets]
            log.warning(
                "Polymarket resolve: no sub-market in %r matches outcome %r. "
                "Available options: %s",
                event_slug, outcome_label, labels,
            )
            return None

        score, m = best
        return PolymarketBinding(
            event_slug=event_slug,
            event_title=event_title,
            outcome_label=outcome_label,
            sub_market_title=m.get("groupItemTitle") or m.get("question") or "",
            condition_id=m.get("conditionId") or "",
            sub_market_slug=m.get("slug", ""),
        )

    # ---------- quote ----------

    async def quote(self, binding: PolymarketBinding) -> Optional[PolymarketQuote]:
        # Re-fetch by conditionId (stable across slug changes)
        m = None
        if binding.condition_id:
            m = await self._fetch_market_by_condition_id(binding.condition_id)
        if m is None and binding.sub_market_slug:
            m = await self._fetch_market_by_slug(binding.sub_market_slug)
        if m is None:
            return None

        prices = self._outcome_prices(m)
        outcomes = self._outcomes(m)
        if not prices or not outcomes:
            return None

        # Always take the "Yes" side — index 0 if outcomes[0] == "Yes",
        # else find "Yes" explicitly.
        yes_idx = 0
        for i, o in enumerate(outcomes):
            if str(o).strip().lower() == "yes":
                yes_idx = i; break
        if yes_idx >= len(prices):
            return None

        yes = max(0.001, min(0.999, prices[yes_idx]))
        volume = _as_float(m.get("volumeNum") or m.get("volume") or 0)
        return PolymarketQuote(
            binding=binding,
            yes_price=yes,
            volume=volume,
            timestamp_s=time.time(),
            raw=m,
        )

    # ---------- internals ----------

    async def _fetch_event_by_slug(self, slug: str) -> Optional[dict]:
        try:
            r = await self._client.get(f"{GAMMA_BASE}/events", params={"slug": slug, "limit": 1})
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            log.warning("Polymarket fetch_event(%s) failed: %s", slug, e)
            return None
        if isinstance(data, list):
            return data[0] if data else None
        if isinstance(data, dict) and "events" in data:
            return (data["events"] or [None])[0]
        return None

    async def _fetch_market_by_condition_id(self, cid: str) -> Optional[dict]:
        try:
            r = await self._client.get(
                f"{GAMMA_BASE}/markets",
                params={"condition_ids": cid, "limit": 1},
            )
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            log.warning("Polymarket fetch_by_condition_id(%s...) failed: %s", cid[:12], e)
            return None
        items = data.get("markets") if isinstance(data, dict) else data
        return items[0] if items else None

    async def _fetch_market_by_slug(self, slug: str) -> Optional[dict]:
        try:
            r = await self._client.get(f"{GAMMA_BASE}/markets", params={"slug": slug, "limit": 1})
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            log.warning("Polymarket fetch_by_slug(%s) failed: %s", slug, e)
            return None
        items = data.get("markets") if isinstance(data, dict) else data
        return items[0] if items else None

    @staticmethod
    def _outcomes(m: dict) -> list[str]:
        raw = m.get("outcomes") or "[]"
        if isinstance(raw, str):
            try: return [str(x) for x in json.loads(raw)]
            except json.JSONDecodeError: return []
        if isinstance(raw, list):
            return [str(x) for x in raw]
        return []

    @staticmethod
    def _outcome_prices(m: dict) -> list[float]:
        raw = m.get("outcomePrices") or m.get("outcome_prices") or "[]"
        if isinstance(raw, str):
            try: return [float(x) for x in json.loads(raw)]
            except (json.JSONDecodeError, ValueError, TypeError): return []
        if isinstance(raw, list):
            try: return [float(x) for x in raw]
            except (TypeError, ValueError): return []
        return []


def _as_float(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


if __name__ == "__main__":
    import asyncio

    async def main():
        c = PolymarketClient()
        cases = [
            ("which-party-wins-2028-us-presidential-election", "Democratic"),
            ("fed-decision-in-june-825",                        "No change"),
            ("presidential-election-winner-2028",               "JD Vance"),
            ("democratic-presidential-nominee-2028",            "Gavin Newsom"),
        ]
        for slug, label in cases:
            print(f"\n== {slug} / {label!r} ==")
            b = await c.resolve(slug, label)
            if b:
                print(f"  event    : {b.event_title}")
                print(f"  bound to : {b.sub_market_title!r}")
                print(f"  condId   : {b.condition_id[:18]}…")
                q = await c.quote(b)
                if q:
                    print(f"  YES price: {q.yes_price:.3f}  vol={q.volume:.0f}")
            else:
                print("  NOT RESOLVED")
        await c.close()

    asyncio.run(main())
