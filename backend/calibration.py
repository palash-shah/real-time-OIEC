"""
calibration.py — rolling sigma estimator for the Jacobi diffusion.

Under dP = sigma * sqrt(P*(1-P)) dW, the normalized increment
  Z_t = (P_{t+dt} - P_t) / sqrt(P_t * (1 - P_t))
satisfies Var(Z_t) ≈ sigma^2 * dt, so sigma ≈ sqrt( Var(Z_t) / dt ).

In practice prices are observed at irregular intervals; we convert each
observed increment to an annualized contribution and take a trimmed mean
to resist outliers (a single price glitch should not blow the calibration).
"""

from __future__ import annotations

import math
from collections import deque
from typing import Deque, Iterable


SEC_PER_YEAR = 365.25 * 24 * 3600


def _quantile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    i = max(0, min(len(s) - 1, int(q * (len(s) - 1))))
    return s[i]


def estimate_sigma_from_increments(
    prices: Iterable[float],
    timestamps: Iterable[float],
    winsor: float = 0.05,
) -> float:
    """Given arrays of observed prices and unix-seconds timestamps,
    return an estimate of the Jacobi sigma (annualized)."""
    p_list = list(prices)
    t_list = list(timestamps)
    if len(p_list) < 4:
        return 1.0  # fallback prior
    contribs: list[float] = []
    for i in range(1, len(p_list)):
        dP = p_list[i] - p_list[i - 1]
        dt_sec = max(t_list[i] - t_list[i - 1], 1.0)
        dt_yr = dt_sec / SEC_PER_YEAR
        Pm = 0.5 * (p_list[i] + p_list[i - 1])
        denom = max(Pm * (1 - Pm), 1e-6)
        # sigma^2 contribution of this step
        c = (dP * dP) / (denom * dt_yr)
        if math.isfinite(c) and c > 0:
            contribs.append(c)
    if not contribs:
        return 1.0

    # Trim tails to limit the effect of price glitches / stale ticks
    lo = _quantile(contribs, winsor)
    hi = _quantile(contribs, 1.0 - winsor)
    clipped = [max(lo, min(hi, c)) for c in contribs]
    var = sum(clipped) / len(clipped)
    sigma = math.sqrt(max(var, 1e-8))
    # Keep within a sane band — event-market sigma is typically in [0.2, 3.0]
    return max(0.2, min(3.0, sigma))


class HistoryBuffer:
    """Fixed-capacity ring buffer of (timestamp, price) observations per market."""

    def __init__(self, capacity: int = 150) -> None:
        self.capacity = capacity
        self._buf: Deque[tuple[float, float]] = deque(maxlen=capacity)

    def push(self, ts: float, price: float) -> None:
        # Dedup: don't record identical consecutive price+time
        if self._buf and self._buf[-1] == (ts, price):
            return
        self._buf.append((ts, price))

    def prefill(self, points: Iterable[tuple[float, float]]) -> None:
        for ts, p in points:
            self.push(ts, p)

    def as_lists(self) -> tuple[list[float], list[float]]:
        if not self._buf:
            return [], []
        ts = [t for t, _ in self._buf]
        ps = [p for _, p in self._buf]
        return ts, ps

    def __len__(self) -> int:
        return len(self._buf)

    @property
    def latest(self) -> tuple[float, float] | None:
        return self._buf[-1] if self._buf else None


if __name__ == "__main__":  # sanity test
    # simulate a known-sigma path, estimate sigma back
    import random
    random.seed(1)
    sigma_true = 1.2
    dt = 1 / 365
    P = 0.5
    ts = [0.0]
    ps = [P]
    for i in range(300):
        dW = random.gauss(0, 1) * math.sqrt(dt)
        P = P + sigma_true * math.sqrt(P * (1 - P)) * dW
        P = max(0.02, min(0.98, P))
        ts.append((i + 1) * dt * SEC_PER_YEAR)
        ps.append(P)
    est = estimate_sigma_from_increments(ps, ts)
    print(f"true sigma={sigma_true:.3f}  estimated={est:.3f}")
