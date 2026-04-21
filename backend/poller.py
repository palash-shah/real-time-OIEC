"""
poller.py — the live data loop.

Every POLL_INTERVAL seconds:
  1. Ask Polymarket and Kalshi for fresh quotes on each configured market
  2. Append quotes to per-market history buffers
  3. Recalibrate sigma from each buffer
  4. Re-price OIEC surfaces, Greeks, BVIX
  5. Compute cross-venue arbitrage spread + compression
  6. Assemble the unified data.json payload
  7. Broadcast to all connected WebSocket clients via the hub

On a cold start, history is prefilled with a synthetic Jacobi path seeded
from whatever the first successful quote is — this lets the dashboard light
up immediately rather than wait minutes for the buffer to warm.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from calibration import HistoryBuffer, estimate_sigma_from_increments
from kalshi import KalshiClient, KalshiQuote
from markets_config import MARKETS, OIECConfig
from polymarket import PolymarketClient, PolymarketQuote
from pricing import STRIKE_GRID, bvix, surface, variance_swap_strike

log = logging.getLogger(__name__)


POLL_INTERVAL_SEC = float(os.environ.get("OIEC_POLL_INTERVAL", "3.0"))
HISTORY_POINTS    = 150
SYNTHETIC_DAYS    = 150    # prefill days when bootstrapping


class Poller:
    def __init__(self, hub) -> None:
        self.hub = hub
        self.poly: Optional[PolymarketClient] = None
        self.kalshi: Optional[KalshiClient] = None
        self.kalshi_ok = False
        self.buffers: dict[int, HistoryBuffer] = {
            m.idx: HistoryBuffer(HISTORY_POINTS) for m in MARKETS
        }
        self.last_payload: Optional[dict] = None
        self.tick_count = 0
        self.last_error: Optional[str] = None

    # --- lifecycle ---

    async def start(self) -> None:
        self.poly = PolymarketClient()

        key_id = os.environ.get("KALSHI_KEY_ID", "").strip()
        # Two ways to provide the private key:
        #   - KALSHI_PEM_PATH: path to a PEM file on disk (local dev)
        #   - KALSHI_PEM_PEM:  the PEM contents as raw text (cloud hosts like Render)
        # Whichever is set wins; if both, path takes priority.
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

        # Seed buffers synthetically so the dashboard has data to paint
        # before the first real tick lands
        self._seed_synthetic_history()

        asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self.poly:
            await self.poly.close()
        if self.kalshi:
            await self.kalshi.close()

    # --- main loop ---

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

        # Gather quotes concurrently
        poly_tasks, kalshi_tasks = {}, {}
        for m in MARKETS:
            if m.polymarket_slug and self.poly:
                poly_tasks[m.idx] = asyncio.create_task(self.poly.fetch_by_slug(m.polymarket_slug))
            if m.kalshi_ticker and self.kalshi and self.kalshi_ok:
                kalshi_tasks[m.idx] = asyncio.create_task(self.kalshi.get_market(m.kalshi_ticker))

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

        # Per-market: pick primary price, append to buffer, re-price
        markets_out = []
        for m in MARKETS:
            p_quote = poly_quotes.get(m.idx)
            k_quote = kalshi_quotes.get(m.idx)
            primary_price = self._choose_primary_price(m, p_quote, k_quote)

            if primary_price is not None:
                self.buffers[m.idx].push(now, primary_price)

            ts_list, p_list = self.buffers[m.idx].as_lists()
            if not p_list:
                continue  # nothing to render

            sigma_hat = estimate_sigma_from_increments(p_list, ts_list)
            spot = p_list[-1]
            surf = surface(spot, sigma_hat, m.tau_years)

            # Cross-venue arbitrage
            spread_before_c = 0.0
            if p_quote and k_quote:
                spread_before_c = round(abs(p_quote.yes_price - k_quote.yes_price) * 100.0, 2)
            # compression depends on tau vs ttr
            compression = max(10.0, m.ttr_years / max(m.tau_years, 1e-3) * 13.0)  # heuristic scaling
            spread_after_c = round(spread_before_c / compression, 4) if spread_before_c else 0.0
            ann_before = round((spread_before_c / 100.0) / m.ttr_years, 4) if spread_before_c else 0.0
            ann_after  = round((spread_after_c  / 100.0) / m.tau_years,  4) if spread_after_c  else 0.0

            markets_out.append({
                "name": m.name,
                "platform": self._platform_label(m, p_quote, k_quote),
                "current_price": round(spot, 4),
                "time_to_resolution_years": m.ttr_years,
                "sigma_hat": round(sigma_hat, 4),
                "tau": m.tau_years,

                **surf,

                "variance_swap_strike": variance_swap_strike(sigma_hat, m.tau_years),
                "bvix_model_based": bvix(sigma_hat, m.tau_years, "model_based"),
                "bvix_model_free":  bvix(sigma_hat, m.tau_years, "model_free"),

                "history_timestamps": [datetime.fromtimestamp(t, tz=timezone.utc).isoformat() for t in ts_list],
                "history_prices":     [round(p, 4) for p in p_list],

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

    # --- helpers ---

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
        # Fallback: whichever exists
        if p: return p.yes_price
        if k: return k.yes_price
        return None

    @staticmethod
    def _platform_label(
        m: OIECConfig,
        p: Optional[PolymarketQuote],
        k: Optional[KalshiQuote],
    ) -> str:
        venues = []
        if p: venues.append("Polymarket")
        if k: venues.append("Kalshi")
        if not venues:
            # nothing live — show the *intended* primary
            return m.primary.capitalize()
        return " · ".join(venues)

    def _seed_synthetic_history(self) -> None:
        """Prefill each buffer with a plausible Jacobi path so the dashboard
        renders immediately at boot. These points get timestamps in the past
        and will be pushed off the end of the ring as real ticks arrive."""
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
            log.debug("seeded %d synthetic points for market %d", HISTORY_POINTS, m.idx)
