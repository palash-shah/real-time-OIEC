"""
poller.py — live data loop.

Startup:
    1. For each market in markets_config, resolve its Polymarket binding
       (search query + outcome label -> conditionId + outcome index).
       If Kalshi is configured, do the analogous search for a matching ticker.
    2. Seed history buffers with synthetic Jacobi paths so the dashboard
       paints immediately; these decay off the back of the ring as real
       ticks land.

Tick (every POLL_INTERVAL_SEC):
    1. Fetch each resolved binding concurrently.
    2. Append fresh prices to per-market history buffers.
    3. Recalibrate sigma from each buffer.
    4. Re-price OIEC surface, Greeks, BVIX.
    5. Compute cross-venue arbitrage if both venues quoted.
    6. Build unified payload and broadcast via the hub.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import time
from datetime import datetime, timezone
from typing import Optional

from calibration import HistoryBuffer, estimate_sigma_from_increments
from kalshi import KalshiClient, KalshiQuote
from markets_config import MARKETS, OIECConfig
from polymarket import PolymarketBinding, PolymarketClient, PolymarketQuote
from pricing import bvix, surface, variance_swap_strike

log = logging.getLogger(__name__)


POLL_INTERVAL_SEC = float(os.environ.get("OIEC_POLL_INTERVAL", "3.0"))
HISTORY_POINTS    = 150
SYNTHETIC_DAYS    = 150    # age in days of the synthetic prefill


class Poller:
    def __init__(self, hub) -> None:
        self.hub = hub
        self.poly: Optional[PolymarketClient] = None
        self.kalshi: Optional[KalshiClient] = None
        self.kalshi_ok = False

        # Resolved bindings — populated once at startup
        self.poly_bind: dict[int, Optional[PolymarketBinding]] = {}
        self.kalshi_ticker: dict[int, Optional[str]] = {}

        self.buffers: dict[int, HistoryBuffer] = {
            m.idx: HistoryBuffer(HISTORY_POINTS) for m in MARKETS
        }
        self.last_payload: Optional[dict] = None
        self.tick_count = 0
        self.last_error: Optional[str] = None

    # ---------- lifecycle ----------

    async def start(self) -> None:
        self.poly = PolymarketClient()

        key_id = os.environ.get("KALSHI_KEY_ID", "").strip()
        pem_path = os.environ.get("KALSHI_PEM_PATH", "").strip()
        pem_text = os.environ.get("KALSHI_PEM_PEM", "").strip()
        pem_source = pem_path or pem_text
        demo = os.environ.get("KALSHI_ENV", "prod").lower() == "demo"

        if key_id and pem_source:
            try:
                self.kalshi = KalshiClient(key_id, pem_source, demo=demo)
                self.kalshi_ok = await self.kalshi.probe_auth()
                if self.kalshi_ok:
                    log.info("Kalshi auth ok (%s)", "demo" if demo else "prod")
                else:
                    log.warning("Kalshi auth probe failed; continuing Polymarket-only")
            except Exception as e:
                log.warning("Kalshi init failed (%s); continuing Polymarket-only", e)
                self.kalshi_ok = False
        else:
            log.info("No Kalshi credentials configured; Polymarket-only mode")

        await self._resolve_markets()
        self._seed_synthetic_history()
        asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self.poly:
            await self.poly.close()
        if self.kalshi:
            await self.kalshi.close()

    # ---------- resolution (one-time) ----------

    async def _resolve_markets(self) -> None:
        """Resolve each market to stable bindings on the configured venues."""
        for m in MARKETS:
            # Polymarket
            if m.poly_query and self.poly:
                try:
                    b = await self.poly.resolve(
                        m.poly_query,
                        m.poly_outcome,
                        fallback_slug=m.poly_slug,
                    )
                    self.poly_bind[m.idx] = b
                except Exception as e:
                    log.warning("poly resolve failed for %r: %s", m.name, e)
                    self.poly_bind[m.idx] = None
            else:
                self.poly_bind[m.idx] = None

            # Kalshi: if exact ticker provided, use it. Otherwise search by query.
            if self.kalshi and self.kalshi_ok:
                if m.kalshi_ticker:
                    self.kalshi_ticker[m.idx] = m.kalshi_ticker
                elif m.kalshi_query:
                    try:
                        mkts = await self.kalshi.list_markets(series_ticker=m.kalshi_query, limit=20)
                        if mkts:
                            # pick highest-volume match
                            best = max(mkts, key=lambda k: k.volume or 0)
                            self.kalshi_ticker[m.idx] = best.ticker
                            log.info(
                                "Kalshi bound %r -> ticker=%s  (vol=%.0f)",
                                m.name, best.ticker, best.volume,
                            )
                    except Exception as e:
                        log.warning("kalshi resolve failed for %r: %s", m.name, e)
                        self.kalshi_ticker[m.idx] = None
                else:
                    self.kalshi_ticker[m.idx] = None
            else:
                self.kalshi_ticker[m.idx] = None

    # ---------- main loop ----------

    async def _run_forever(self) -> None:
        while True:
            started = time.time()
            try:
                await self._tick()
                self.last_error = None
            except Exception as e:
                log.exception("poll tick failed")
                self.last_error = str(e)
            elapsed = time.time() - started
            sleep_for = max(0.5, POLL_INTERVAL_SEC - elapsed)
            await asyncio.sleep(sleep_for)

    async def _tick(self) -> None:
        self.tick_count += 1
        now = time.time()

        # --- concurrent fetches ---
        poly_tasks: dict[int, asyncio.Task] = {}
        kalshi_tasks: dict[int, asyncio.Task] = {}
        for m in MARKETS:
            b = self.poly_bind.get(m.idx)
            if b and self.poly:
                poly_tasks[m.idx] = asyncio.create_task(self.poly.quote(b))
            t = self.kalshi_ticker.get(m.idx)
            if t and self.kalshi and self.kalshi_ok:
                kalshi_tasks[m.idx] = asyncio.create_task(self.kalshi.get_market(t))

        poly_quotes: dict[int, Optional[PolymarketQuote]] = {}
        for i, t in poly_tasks.items():
            try:
                poly_quotes[i] = await t
            except Exception as e:
                log.warning("poly task %s failed: %s", i, e)
                poly_quotes[i] = None

        kalshi_quotes: dict[int, Optional[KalshiQuote]] = {}
        for i, t in kalshi_tasks.items():
            try:
                kalshi_quotes[i] = await t
            except Exception as e:
                log.warning("kalshi task %s failed: %s", i, e)
                kalshi_quotes[i] = None

        # --- per-market compute ---
        markets_out = []
        for m in MARKETS:
            p_quote = poly_quotes.get(m.idx)
            k_quote = kalshi_quotes.get(m.idx)
            primary_price = self._choose_primary_price(m, p_quote, k_quote)

            if primary_price is not None:
                self.buffers[m.idx].push(now, primary_price)

            ts_list, p_list = self.buffers[m.idx].as_lists()
            if not p_list:
                continue

            sigma_hat = estimate_sigma_from_increments(p_list, ts_list)
            spot = p_list[-1]
            surf = surface(spot, sigma_hat, m.tau_years)

            # Cross-venue arbitrage (only meaningful if both venues returned)
            spread_before_c = 0.0
            if p_quote and k_quote:
                spread_before_c = round(abs(p_quote.yes_price - k_quote.yes_price) * 100.0, 2)
            compression = max(10.0, m.ttr_years / max(m.tau_years, 1e-3) * 13.0)
            spread_after_c = round(spread_before_c / compression, 4) if spread_before_c else 0.0
            ann_before = round((spread_before_c / 100.0) / m.ttr_years, 4) if spread_before_c else 0.0
            ann_after  = round((spread_after_c  / 100.0) / m.tau_years,  4) if spread_after_c  else 0.0

            markets_out.append({
                "name": m.name,
                "platform": self._platform_label(p_quote, k_quote),
                "current_price": round(spot, 4),
                "time_to_resolution_years": m.ttr_years,
                "sigma_hat": round(sigma_hat, 4),
                "tau": m.tau_years,
                **surf,
                "variance_swap_strike": variance_swap_strike(sigma_hat, m.tau_years),
                "bvix_model_based": bvix(sigma_hat, m.tau_years, "model_based"),
                "bvix_model_free":  bvix(sigma_hat, m.tau_years, "model_free"),
                "history_timestamps": [
                    datetime.fromtimestamp(t, tz=timezone.utc).isoformat() for t in ts_list
                ],
                "history_prices": [round(p, 4) for p in p_list],
                "scheduled_events": m.scheduled_events,
                "cross_platform_spread_cents": spread_before_c,
                "arbitrage": {
                    "spread_before_cents": spread_before_c,
                    "spread_after_cents":  spread_after_c,
                    "compression_factor":  round(compression, 1),
                    "annualized_return_before": ann_before,
                    "annualized_return_after":  ann_after,
                },
                "_source": {
                    "polymarket": p_quote.yes_price if p_quote else None,
                    "kalshi":     k_quote.yes_price if k_quote else None,
                    "poly_outcome": p_quote.binding.outcome_label if p_quote else None,
                    "poly_slug":    p_quote.binding.slug if p_quote else None,
                },
            })

        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "markets": markets_out,
            "_meta": {
                "tick": self.tick_count,
                "kalshi_ok": self.kalshi_ok,
                "poll_interval_sec": POLL_INTERVAL_SEC,
                "last_error": self.last_error,
            },
        }
        self.last_payload = payload
        await self.hub.broadcast(payload)

    # ---------- helpers ----------

    def _choose_primary_price(
        self,
        m: OIECConfig,
        p: Optional[PolymarketQuote],
        k: Optional[KalshiQuote],
    ) -> Optional[float]:
        if m.primary == "polymarket" and p:
            return p.yes_price
        if m.primary == "kalshi" and k:
            return k.yes_price
        if p: return p.yes_price
        if k: return k.yes_price
        return None

    @staticmethod
    def _platform_label(p: Optional[PolymarketQuote], k: Optional[KalshiQuote]) -> str:
        venues = []
        if p: venues.append("Polymarket")
        if k: venues.append("Kalshi")
        return " · ".join(venues) if venues else "—"

    def _seed_synthetic_history(self) -> None:
        """Prefill each buffer with a plausible Jacobi path so the dashboard
        renders immediately at boot. Synthetic points decay off as real ticks
        land."""
        now = time.time()
        dt_sec = (SYNTHETIC_DAYS * 86400) / HISTORY_POINTS
        for m in MARKETS:
            buf = self.buffers[m.idx]
            if buf:
                continue
            P = random.uniform(0.25, 0.70)
            sigma = 1.0
            rng = random.Random(m.idx * 997 + 13)
            dt_yr = dt_sec / (365.25 * 86400)
            for i in range(HISTORY_POINTS):
                t = now - (HISTORY_POINTS - 1 - i) * dt_sec
                dW = rng.gauss(0, 1) * math.sqrt(dt_yr)
                P = P + sigma * math.sqrt(max(P * (1 - P), 1e-6)) * dW
                P = max(0.02, min(0.98, P))
                buf.push(t, P)
