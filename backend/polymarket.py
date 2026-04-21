"""
polymarket.py — Polymarket Gamma API client (public, no authentication).

Uses the `/markets` endpoint. Markets are addressed by `slug`.
Returns a normalized {yes_price, volume, timestamp_s} per market.
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
class PolymarketQuote:
    slug: str
    question: str
    yes_price: float          # YES price, [0, 1]
    volume: float             # cumulative USDC volume
    condition_id: str
    timestamp_s: float
    raw: dict                 # keep for debugging


class PolymarketClient:
    def __init__(self, timeout: float = 10.0) -> None:
        self._client = httpx.AsyncClient(timeout=timeout, headers={
            "User-Agent": "OIEC-Demo/0.1 (research)",
            "Accept": "application/json",
        })

    async def close(self) -> None:
        await self._client.aclose()

    async def fetch_by_slug(self, slug: str) -> Optional[PolymarketQuote]:
        url = f"{GAMMA_BASE}/markets"
        try:
            r = await self._client.get(url, params={"slug": slug, "limit": 1})
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            log.warning("Polymarket fetch_by_slug(%s) failed: %s", slug, e)
            return None
        except json.JSONDecodeError as e:
            log.warning("Polymarket non-JSON response for %s: %s", slug, e)
            return None

        # Gamma returns either a list or a single-object array
        if isinstance(data, dict) and "markets" in data:
            items = data["markets"]
        elif isinstance(data, list):
            items = data
        else:
            items = [data]
        if not items:
            log.info("Polymarket: no market for slug %r", slug)
            return None

        m = items[0]
        return self._parse_market(m, slug)

    async def search(self, query: str, limit: int = 10) -> list[dict]:
        """Free-form search — useful for bootstrap/discovery."""
        try:
            r = await self._client.get(
                f"{GAMMA_BASE}/markets",
                params={"q": query, "limit": limit, "active": "true"},
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and "markets" in data:
                return data["markets"]
            if isinstance(data, list):
                return data
            return [data]
        except httpx.HTTPError as e:
            log.warning("Polymarket search(%r) failed: %s", query, e)
            return []

    @staticmethod
    def _parse_market(m: dict, slug: str) -> Optional[PolymarketQuote]:
        # outcomePrices can come as a JSON-encoded string or a list
        raw_prices = m.get("outcomePrices") or m.get("outcome_prices") or "[]"
        if isinstance(raw_prices, str):
            try:
                prices = json.loads(raw_prices)
            except json.JSONDecodeError:
                prices = []
        else:
            prices = raw_prices

        if not prices:
            return None

        # Convention: index 0 is YES
        try:
            yes = float(prices[0])
        except (TypeError, ValueError):
            return None

        volume = _as_float(m.get("volume") or m.get("volumeNum") or 0)
        cond = m.get("conditionId") or m.get("condition_id") or ""
        q = m.get("question") or m.get("title") or slug

        return PolymarketQuote(
            slug=slug,
            question=q,
            yes_price=max(0.001, min(0.999, yes)),
            volume=volume,
            condition_id=cond,
            timestamp_s=time.time(),
            raw=m,
        )


def _as_float(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


# Smoke test when run directly
if __name__ == "__main__":
    import asyncio

    async def main():
        c = PolymarketClient()
        hits = await c.search("presidential 2028 democrat", limit=5)
        print(f"search returned {len(hits)} markets")
        for h in hits[:5]:
            print(f"  - {h.get('slug'):60s}  {h.get('question', '')[:60]}")
        if hits:
            q = await c.fetch_by_slug(hits[0]["slug"])
            print(f"\nquote: {q}")
        await c.close()

    asyncio.run(main())
