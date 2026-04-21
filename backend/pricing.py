"""
pricing.py — OIEC pricing engine (Jacobi-Bachelier approximation).

Used by the live poller. Ports the same math as generate_data.py so the
frontend sees the same surface shape whether the data is synthetic or live.

Model: bounded event future P in [0,1], Jacobi diffusion
    dP = sigma * sqrt(P*(1-P)) dW

Call / put prices approximated via a Bachelier-style form using the
instantaneous diffusion's standard deviation over horizon tau.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


SQRT_2PI = math.sqrt(2 * math.pi)


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))


def call_price(P: float, K: float, sigma: float, tau: float) -> float:
    variance = max(P * (1 - P), 1e-6)
    sd = sigma * math.sqrt(variance) * math.sqrt(max(tau, 1e-6))
    if sd < 1e-8:
        return max(P - K, 0.0)
    d = (P - K) / sd
    return max((P - K) * _norm_cdf(d) + sd * _norm_pdf(d), 0.0)


def put_price(P: float, K: float, sigma: float, tau: float) -> float:
    # put-call parity on the event future: C - Put = P - K
    return max(call_price(P, K, sigma, tau) - (P - K), 0.0)


@dataclass
class Greeks:
    delta_c: float
    delta_p: float
    gamma: float
    vega: float
    theta: float


def greeks(P: float, K: float, sigma: float, tau: float) -> Greeks:
    variance = max(P * (1 - P), 1e-6)
    sd = sigma * math.sqrt(variance) * math.sqrt(max(tau, 1e-6))
    if sd < 1e-8:
        return Greeks(0.0, 0.0, 0.0, 0.0, 0.0)
    d = (P - K) / sd
    pdf = _norm_pdf(d)
    cdf = _norm_cdf(d)
    return Greeks(
        delta_c=cdf,
        delta_p=cdf - 1.0,
        gamma=pdf / sd,
        vega=pdf * math.sqrt(variance) * math.sqrt(max(tau, 1e-6)),
        theta=-0.5 * sigma * math.sqrt(variance) * pdf / math.sqrt(max(tau, 1e-6)),
    )


# Standard strike grid used for every market's surface
STRIKE_GRID = [round(0.05 * k, 2) for k in range(1, 20)]  # 0.05 .. 0.95


def surface(P: float, sigma: float, tau: float) -> dict:
    """Full surface for the strike grid: call & put prices plus all Greeks."""
    calls, puts = [], []
    dcs, dps, gms, vgs, ths = [], [], [], [], []
    for K in STRIKE_GRID:
        calls.append(round(call_price(P, K, sigma, tau), 4))
        puts.append(round(put_price(P, K, sigma, tau), 4))
        g = greeks(P, K, sigma, tau)
        dcs.append(round(g.delta_c, 4))
        dps.append(round(g.delta_p, 4))
        gms.append(round(g.gamma, 4))
        vgs.append(round(g.vega, 4))
        ths.append(round(g.theta, 4))
    return {
        "strikes":     STRIKE_GRID,
        "call_prices": calls,
        "put_prices":  puts,
        "delta_c":     dcs,
        "delta_p":     dps,
        "gamma":       gms,
        "vega":        vgs,
        "theta":       ths,
    }


def variance_swap_strike(sigma: float, tau: float) -> float:
    """Continuous-sample variance swap fair strike under Jacobi at spot P: K_var = sigma^2 * tau.
    (For the unit-variance normalized process; scaled appropriately for P in [0,1].)"""
    return round(sigma * sigma * tau, 4)


def bvix(sigma: float, tau: float, mode: str = "model_based") -> float:
    """BVIX — the VIX analogue for event markets.

    Two estimators:
    - model_based: BVIX = sigma * sqrt(tau) with a correction factor.
      This is the "fit the Jacobi model, read off the diffusion-scale volatility"
      route. Matches what the dashboard's term-structure chart projects.
    - model_free: variance-swap-replicated, approximated here from the calibrated
      sigma with a skew-correction discount.  In live production this would be
      replicated from the observed option surface; we approximate because we
      synthesize the surface, not observe it.
    """
    base = sigma * math.sqrt(max(tau, 1e-6))
    if mode == "model_based":
        return round(base * 0.94, 3)
    return round(base * 0.86, 3)
