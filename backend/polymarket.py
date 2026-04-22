"""
polymarket.py — Polymarket Gamma API client (public, no authentication).

Two-phase model:
    1. resolve(query, outcome_label) — called once at startup for each market.
       Searches Gamma for matching markets, picks the most-liquid one whose
       `outcomes` list contains the desired label, caches the (condition_id,
       outcome_index) binding.
    2. quote(resolved) — called every tick. Re-fetches the same market by
       conditionId (stable identifier), returns the price for the bound
       outcome index.

This fixes the bug where a single `slug` maps to a parent event containing
multiple sub-markets (Dem / Rep / Other), and `outcomePrices[0]` isn't
necessarily the outcome you actually want.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

log = logging.getLogger(__name__)

GAMMA_BASE = "https://gamma-api.polymarket.com"


@dataclass
class PolymarketBinding:
    """Stable handle to a specific market outcome on Polymarket."""
    query:         str
    outcome_label: str
    condition_id:  str
    slug:          str
    question:      str
    outcome_index: int
    outcomes:      list[str] = field(default_factory=list)


@dataclass
class PolymarketQuote:
    binding:     PolymarketBinding
    yes_price:   float
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

    # ---------- resolve (startup) -------------------------------------

    async def resolve(
        self,
        query: str,
        outcome_label: str = "Yes",
        fallback_slug: Optional[str] = None,
    ) -> Optional[PolymarketBinding]:
        candidates = await self._search_markets(query)

        # Always also include the explicit fallback slug if given — the search
        # can rank a less-liquid match higher than the market we actually want.
        if fallback_slug:
            direct = await self._fetch_by_slug(fallback_slug)
            if direct:
                candidates = [direct] + [c for c in candidates if c.get("slug") != fallback_slug]

        if not candidates:
            # Last-ditch: treat the query as a slug
            direct = await self._fetch_by_slug(query)
            if direct:
                candidates = [direct]

        if not candidates:
            log.warning("Polymarket resolve(%r): no markets found", query)
            return None

        target = outcome_label.strip().lower()
        scored: list[tuple[float, dict, int]] = []
        for m in candidates:
            if m.get("closed") is True or m.get("active") is False:
                continue
            outcomes = self._outcomes(m)
            if not outcomes:
                continue
            idx = _match_outcome(outcomes, target)
            if idx is None:
                continue
            vol = _as_float(m.get("volume24hr") or m.get("volumeNum") or m.get("volume") or 0)
            scored.append((vol, m, idx))

        if not scored:
            log.warning(
                "Polymarket resolve(%r, %r): no active market with matching outcome. "
                "Candidates had these outcomes: %s",
                query, outcome_label,
                [self._outcomes(c) for c in candidates[:3]],
            )
            return None

        scored.sort(key=lambda t: t[0], reverse=True)
        vol, m, idx = scored[0]
        outcomes = self._outcomes(m)
        binding = PolymarketBinding(
            query=query,
            outcome_label=outcomes[idx],
            condition_id=m.get("conditionId") or m.get("condition_id") or "",
            slug=m.get("slug", ""),
            question=m.get("question") or m.get("title") or query,
            outcome_index=idx,
            outcomes=outcomes,
        )
        log.info(
            "Polymarket bound %r / %r -> slug=%s outcome=%r (idx %d) vol24h=%.0f",
            query, outcome_label, binding.slug, binding.outcome_label, idx, vol,
        )
        return binding

    # ---------- quote (every tick) ------------------------------------

    async def quote(self, binding: PolymarketBinding) -> Optional[PolymarketQuote]:
        m = None
        if binding.condition_id:
            m = await self._fetch_by_condition_id(binding.condition_id)
        if m is None and binding.slug:
            m = await self._fetch_by_slug(binding.slug)
        if m is None:
            return None

        prices = self._outcome_prices(m)
        if not prices or binding.outcome_index >= len(prices):
            return None

        yes = max(0.001, min(0.999, prices[binding.outcome_index]))
        volume = _as_float(m.get("volumeNum") or m.get("volume") or 0)
        return PolymarketQuote(
            binding=binding,
            yes_price=yes,
            volume=volume,
            timestamp_s=time.time(),
            raw=m,
        )

    # ---------- internals ---------------------------------------------

    async def _search_markets(self, query: str, limit: int = 20) -> list[dict]:
        try:
            r = await self._client.get(
                f"{GAMMA_BASE}/markets",
                params={"q": query, "limit": limit, "active": "true"},
            )
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            log.warning("Polymarket search(%r) failed: %s", query, e)
            return []
        if isinstance(data, dict) and "markets" in data:
            return data["markets"]
        if isinstance(data, list):
            return data
        return []

    async def _fetch_by_slug(self, slug: str) -> Optional[dict]:
        try:
            r = await self._client.get(f"{GAMMA_BASE}/markets", params={"slug": slug, "limit": 1})
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            log.warning("Polymarket fetch_by_slug(%s) failed: %s", slug, e)
            return None
        items = data.get("markets") if isinstance(data, dict) else data
        if not items:
            return None
        return items[0]

    async def _fetch_by_condition_id(self, condition_id: str) -> Optional[dict]:
        try:
            r = await self._client.get(
                f"{GAMMA_BASE}/markets",
                params={"condition_ids": condition_id, "limit": 1},
            )
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            log.warning("Polymarket fetch_by_condition_id(%s) failed: %s", condition_id[:12], e)
            return None
        items = data.get("markets") if isinstance(data, dict) else data
        if not items:
            return None
        return items[0]

    @staticmethod
    def _outcomes(m: dict) -> list[str]:
        raw = m.get("outcomes") or "[]"
        if isinstance(raw, str):
            try:
                return [str(x) for x in json.loads(raw)]
            except json.JSONDecodeError:
                return []
        if isinstance(raw, list):
            return [str(x) for x in raw]
        return []

    @staticmethod
    def _outcome_prices(m: dict) -> list[float]:
        raw = m.get("outcomePrices") or m.get("outcome_prices") or "[]"
        if isinstance(raw, str):
            try:
                return [float(x) for x in json.loads(raw)]
            except (json.JSONDecodeError, TypeError, ValueError):
                return []
        if isinstance(raw, list):
            try:
                return [float(x) for x in raw]
            except (TypeError, ValueError):
                return []
        return []


def _match_outcome(outcomes: list[str], target: str) -> Optional[int]:
    lowered = [o.strip().lower() for o in outcomes]
    if target in lowered:
        return lowered.index(target)
    for i, o in enumerate(lowered):
        if o.startswith(target) or target.startswith(o):
            return i
    for i, o in enumerate(lowered):
        if target in o or o in target:
            return i
    return None


def _as_float(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


if __name__ == "__main__":
    import asyncio

    async def main():
        c = PolymarketClient()
        for query, label in [
            ("2028 presidential democrat", "Democrat"),
            ("fed rate decision", "Yes"),
            ("bitcoin 150000 2026", "Yes"),
        ]:
            b = await c.resolve(query, label)
            if b:
                print(f"\n[{query!r} / {label!r}]")
                print(f"  -> slug: {b.slug}")
                print(f"  -> outcome: {b.outcome_label} (idx {b.outcome_index})")
                print(f"  -> question: {b.question}")
                q = await c.quote(b)
                if q:
                    print(f"  -> price: {q.yes_price:.3f}  volume: {q.volume:.0f}")
            else:
                print(f"\n[{query!r} / {label!r}] NOT RESOLVED")
        await c.close()

    asyncio.run(main())
