"""
pinning.py — terminal-pinning diagnostics + bridge-vs-Jacobi GOF.

Computes, alongside the v2 pinning panel, a goodness-of-fit comparison between
the bridge model (β₀ from realized QV of logit P) and the Jacobi diffusion
baseline (σ_J from realized variance). Both models predict per-tick variance
of ΔP; we score each on the same realized squared increments using the
QLIKE loss, which is the standard volatility-forecasting loss in the
realized-volatility literature.

Convention:  All times in YEARS.  SEC_PER_YEAR matches calibration.py.

QLIKE per tick i:    L_i = r²_i / σ²_pred,i  −  log(r²_i / σ²_pred,i)  −  1
where r_i = ΔP_i and σ²_pred,i is each model's predicted variance.

Lower QLIKE = better fit. Ratio (Jacobi / Bridge) > 1 means bridge wins.

Public surface (everything poller.py needs):
    estimate_beta0(prices, timestamps, ttr_years)     -> float
    sigma_star_atm(p)                                 -> float
    pinning_panel(prices, timestamps, ttr_years, β₀)  -> dict
    goodness_of_fit(prices, timestamps, ttr_years,
                    sigma_J, beta0)                   -> dict     (NEW)
"""
from __future__ import annotations

import math
from typing import Iterable

SEC_PER_YEAR = 365.25 * 24 * 3600

_CHART_POINTS = 80


# ---------------------------------------------------------------------------
# numerical helpers
# ---------------------------------------------------------------------------

def _erfinv(x: float) -> float:
    """Approximate inverse erf — Winitzki's two-term form, ~3e-3 max error."""
    if x >= 1.0:
        return float("inf")
    if x <= -1.0:
        return float("-inf")
    a = 0.147
    ln = math.log(1.0 - x * x)
    first = 2.0 / (math.pi * a) + ln / 2.0
    inside = first * first - ln / a
    return math.copysign(1.0, x) * math.sqrt(math.sqrt(inside) - first)


def _phi_inv(p: float) -> float:
    """Standard-normal quantile (inverse CDF). Used for the ATM closed form."""
    if p <= 0:   return float("-inf")
    if p >= 1:   return float("inf")
    return math.sqrt(2.0) * _erfinv(2.0 * p - 1.0)


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1.0 - p))


# ---------------------------------------------------------------------------
# 1. β₀ from realized QV of logit price
# ---------------------------------------------------------------------------

def estimate_beta0(
    prices: Iterable[float],
    timestamps: Iterable[float],
    ttr_years: float,
    *,
    buffer_seconds_to_skip: float = 60.0,
) -> float:
    """β̂₀ from realized QV of L_t = logit(P_t) under β(t) = β₀/√(T−t)."""
    p_list = [float(p) for p in prices]
    t_list = [float(t) for t in timestamps]
    n = len(p_list)
    if n < 8 or ttr_years <= 0:
        return 1.0

    t0 = t_list[0]
    times_yr = [(ts - t0) / SEC_PER_YEAR for ts in t_list]
    cap = max(ttr_years - buffer_seconds_to_skip / SEC_PER_YEAR, 1e-6)

    qv = 0.0
    lam0 = math.log(ttr_years / max(ttr_years - times_yr[0], 1e-9))
    lam_end = lam0
    used_pairs = 0
    for i in range(1, n):
        ti = min(times_yr[i], cap)
        ti_prev = min(times_yr[i - 1], cap)
        if ti <= ti_prev:
            continue
        pi = min(max(p_list[i], 5e-3), 1 - 5e-3)
        pj = min(max(p_list[i - 1], 5e-3), 1 - 5e-3)
        dL = math.log(pi / (1 - pi)) - math.log(pj / (1 - pj))
        qv += dL * dL
        lam_end = math.log(ttr_years / max(ttr_years - ti, 1e-9))
        used_pairs += 1

    span = lam_end - lam0
    if span <= 1e-9 or qv <= 0 or used_pairs < 4:
        return 1.0

    beta = math.sqrt(qv / span)
    return max(0.1, min(5.0, beta))


# ---------------------------------------------------------------------------
# 2. closed-form ATM asymptote
# ---------------------------------------------------------------------------

def sigma_star_atm(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return round(2.0 * _phi_inv(1.0 - p / 2.0), 4)


# ---------------------------------------------------------------------------
# 3. Pinning panel (chart payload) — unchanged from v2
# ---------------------------------------------------------------------------

def pinning_panel(
    prices: list[float],
    timestamps: list[float],
    ttr_years: float,
    beta0: float,
    *,
    n_points: int = _CHART_POINTS,
) -> dict:
    if not prices or not timestamps or len(prices) != len(timestamps):
        return {
            "t_years": [], "pq_obs": [], "envelope_t": [], "envelope": [],
            "t_now_years": 0.0, "ttr_years": ttr_years,
            "beta0": beta0, "sigma_star_atm": sigma_star_atm(0.5),
        }

    t0 = timestamps[0]
    t_now = (timestamps[-1] - t0) / SEC_PER_YEAR

    n = len(prices)
    stride = max(1, n // n_points)
    obs_t, obs_pq = [], []
    for i in range(0, n, stride):
        ti = (timestamps[i] - t0) / SEC_PER_YEAR
        pi = min(max(prices[i], 1e-4), 1 - 1e-4)
        obs_t.append(round(ti, 6))
        obs_pq.append(round(pi * (1 - pi), 5))
    if obs_t and obs_t[-1] != round(t_now, 6):
        last_p = min(max(prices[-1], 1e-4), 1 - 1e-4)
        obs_t.append(round(t_now, 6))
        obs_pq.append(round(last_p * (1 - last_p), 5))

    env_t, env_v = [], []
    exponent = (beta0 * beta0) / 2.0
    p0 = min(max(prices[0], 1e-4), 1 - 1e-4)
    anchor = max(p0 * (1 - p0), 0.001)
    for k in range(n_points + 1):
        t_yr = (k / n_points) * max(ttr_years, 1e-6)
        frac = max((ttr_years - t_yr) / max(ttr_years, 1e-6), 1e-6)
        env_t.append(round(t_yr, 6))
        env_v.append(round(anchor * (frac ** exponent), 5))

    return {
        "t_years":       obs_t,
        "pq_obs":        obs_pq,
        "envelope_t":    env_t,
        "envelope":      env_v,
        "t_now_years":   round(t_now, 6),
        "ttr_years":     round(ttr_years, 4),
        "beta0":         round(beta0, 4),
        "sigma_star_atm": sigma_star_atm(prices[-1]),
    }


# ---------------------------------------------------------------------------
# 4. Goodness-of-fit comparison — Bridge vs Jacobi (NEW)
# ---------------------------------------------------------------------------

def _qlike(realized_sq: float, predicted_var: float) -> float | None:
    """QLIKE loss. Lower is better. Robust to scale, asymmetric (penalizes
    underprediction more than overprediction — the standard property
    a vol-forecasting loss should have, per Patton 2011)."""
    if predicted_var <= 1e-18 or realized_sq <= 0:
        return None
    ratio = realized_sq / predicted_var
    return ratio - math.log(ratio) - 1.0


def goodness_of_fit(
    prices: list[float],
    timestamps: list[float],
    ttr_years: float,
    sigma_J: float,
    beta0: float,
    *,
    sparkline_points: int = 60,
    buffer_seconds_to_skip: float = 60.0,
    min_realized: float = 1e-7,   # increments smaller than this we ignore (no-trade ticks)
) -> dict:
    """Score Jacobi and bridge models on per-tick predicted variance vs realized.

    Returns:
        {
          "jacobi_qlike":    cumulative QLIKE for Jacobi (lower better)
          "bridge_qlike":    cumulative QLIKE for Bridge (lower better)
          "ratio":           jacobi_qlike / bridge_qlike   (>1 = bridge wins)
          "n_obs":           number of usable ticks
          "winner":          "bridge", "jacobi", or "tie"
          "spark_jacobi":    [running QLIKE Jacobi]   length sparkline_points
          "spark_bridge":    [running QLIKE Bridge]   length sparkline_points
          "spark_t":         [years from start]       length sparkline_points
          "advantage_pct":   (jacobi − bridge) / max(jacobi, bridge) × 100,
                             or None if both losses zero
        }
    """
    n = len(prices)
    if n < 8 or n != len(timestamps) or ttr_years <= 0 or sigma_J <= 0 or beta0 <= 0:
        return {
            "jacobi_qlike": None, "bridge_qlike": None, "ratio": None,
            "n_obs": 0, "winner": "tie",
            "spark_jacobi": [], "spark_bridge": [], "spark_t": [],
            "advantage_pct": None,
        }

    t0 = timestamps[0]
    cap_year = max(ttr_years - buffer_seconds_to_skip / SEC_PER_YEAR, 1e-6)

    # Per-tick QLIKE losses (we keep the raw vectors so we can build the sparkline)
    j_losses: list[float] = []
    b_losses: list[float] = []
    times_yr_used: list[float] = []

    for i in range(1, n):
        ti_yr     = (timestamps[i] - t0) / SEC_PER_YEAR
        ti_prev_yr = (timestamps[i - 1] - t0) / SEC_PER_YEAR

        if ti_yr >= cap_year:
            break
        dt_yr = ti_yr - ti_prev_yr
        if dt_yr <= 0:
            continue

        p_now  = min(max(prices[i],     1e-4), 1 - 1e-4)
        p_prev = min(max(prices[i - 1], 1e-4), 1 - 1e-4)
        d_p = p_now - p_prev
        realized_sq = d_p * d_p
        if realized_sq < min_realized * min_realized:
            continue   # skip degenerate / no-move ticks

        # ----- Jacobi predicted variance: σ_J² · P(1−P) · Δt
        # Use trailing P to avoid look-ahead bias
        p_q = max(p_prev * (1 - p_prev), 1e-6)
        var_jacobi = sigma_J * sigma_J * p_q * dt_yr

        # ----- Bridge predicted variance: (P(1−P))² · β₀² · ΔΛ
        # ΔΛ = log[ (T−t_prev) / (T−t_now) ]  (>= 0 always)
        denom = max(ttr_years - ti_yr, 1e-9)
        numer = max(ttr_years - ti_prev_yr, 1e-9)
        d_lam = math.log(numer / denom)
        var_bridge = (p_q ** 2) * (beta0 ** 2) * max(d_lam, 1e-12)

        lj = _qlike(realized_sq, var_jacobi)
        lb = _qlike(realized_sq, var_bridge)
        if lj is None or lb is None or not math.isfinite(lj) or not math.isfinite(lb):
            continue

        j_losses.append(lj)
        b_losses.append(lb)
        times_yr_used.append(ti_yr)

    n_obs = len(j_losses)
    if n_obs < 4:
        return {
            "jacobi_qlike": None, "bridge_qlike": None, "ratio": None,
            "n_obs": n_obs, "winner": "tie",
            "spark_jacobi": [], "spark_bridge": [], "spark_t": [],
            "advantage_pct": None,
        }

    j_total = sum(j_losses) / n_obs
    b_total = sum(b_losses) / n_obs

    # Sparkline: cumulative-mean QLIKE over time (downsampled if needed)
    # so the user sees how the comparison evolves through the buffer.
    stride = max(1, n_obs // sparkline_points)
    spark_j: list[float] = []
    spark_b: list[float] = []
    spark_t: list[float] = []
    cum_j = cum_b = 0.0
    for i in range(n_obs):
        cum_j += j_losses[i]
        cum_b += b_losses[i]
        if (i % stride) == 0 or i == n_obs - 1:
            spark_j.append(round(cum_j / (i + 1), 6))
            spark_b.append(round(cum_b / (i + 1), 6))
            spark_t.append(round(times_yr_used[i], 6))

    # Decide winner — small tolerance to call ties
    rel_diff = (j_total - b_total) / max(abs(j_total), abs(b_total), 1e-12)
    if rel_diff > 0.02:
        winner = "bridge"
    elif rel_diff < -0.02:
        winner = "jacobi"
    else:
        winner = "tie"

    advantage_pct = (
        (j_total - b_total) / max(abs(j_total), abs(b_total)) * 100.0
        if (j_total != 0 or b_total != 0) else None
    )

    return {
        "jacobi_qlike":  round(j_total, 6),
        "bridge_qlike":  round(b_total, 6),
        "ratio":         round(j_total / b_total, 4) if b_total > 0 else None,
        "n_obs":         n_obs,
        "winner":        winner,
        "spark_jacobi":  spark_j,
        "spark_bridge":  spark_b,
        "spark_t":       spark_t,
        "advantage_pct": round(advantage_pct, 2) if advantage_pct is not None else None,
    }


# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import random

    print("=== Sanity tests ===")

    # 1. Sigma* closed forms
    print(f"Σ*(0.5, 0.5) = {sigma_star_atm(0.5):.4f}  (expected ~1.349)")
    print(f"Σ*(0.3, 0.3) = {sigma_star_atm(0.3):.4f}  (expected ~2.073)")
    print(f"Σ*(0.7, 0.7) = {sigma_star_atm(0.7):.4f}  (expected ~0.770)")

    # 2. β₀ recovery on a synthetic bridge path
    random.seed(3)
    T = 1.0; n = 500; beta0_true = 1.2
    times_yr = [i * T / n for i in range(n)]
    P = 0.5
    bridge_prices = [P]
    for i in range(1, n):
        dt = times_yr[i] - times_yr[i - 1]
        if times_yr[i] >= T - 1e-3:
            bridge_prices.append(P); continue
        beta_t = beta0_true / math.sqrt(max(T - times_yr[i - 1], 1e-3))
        L = math.log(P / (1 - P)) + beta_t**2 * dt + beta_t * math.sqrt(dt) * random.gauss(0, 1)
        P = 1.0 / (1.0 + math.exp(-L))
        P = min(max(P, 1e-3), 1 - 1e-3)
        bridge_prices.append(P)
    bridge_ts = [t * SEC_PER_YEAR for t in times_yr]
    print(f"β₀ recovered from bridge path: true=1.200  hat={estimate_beta0(bridge_prices, bridge_ts, T):.3f}")

    # 3. GOF on a synthetic Jacobi path: Jacobi should win
    random.seed(7)
    T_jac = 0.5
    n_jac = 600
    sigma_true = 0.9
    P = 0.5
    jacobi_prices = [P]
    times_jac = [0.0]
    dt = T_jac / n_jac
    for i in range(n_jac):
        dW = random.gauss(0, 1) * math.sqrt(dt)
        P = P + sigma_true * math.sqrt(max(P * (1 - P), 1e-6)) * dW
        P = min(max(P, 0.01), 0.99)
        jacobi_prices.append(P)
        times_jac.append(times_jac[-1] + dt)
    jacobi_ts = [t * SEC_PER_YEAR for t in times_jac]

    sigma_J_hat = 0.9
    beta0_hat = estimate_beta0(jacobi_prices, jacobi_ts, T_jac)
    gof_jac = goodness_of_fit(jacobi_prices, jacobi_ts, T_jac, sigma_J_hat, beta0_hat)
    print(f"\nGOF on Jacobi-generated path (β̂₀={beta0_hat:.3f}, σ_J={sigma_J_hat:.2f}):")
    print(f"  jacobi_qlike: {gof_jac['jacobi_qlike']:.4f}")
    print(f"  bridge_qlike: {gof_jac['bridge_qlike']:.4f}")
    print(f"  ratio (J/B):  {gof_jac['ratio']}")
    print(f"  winner:       {gof_jac['winner']}")
    print(f"  advantage:    {gof_jac['advantage_pct']:.1f}%")

    # 4. GOF on a synthetic bridge path: bridge should win  
    sigma_J_hat2 = 0.9
    gof_br = goodness_of_fit(bridge_prices, bridge_ts, T, sigma_J_hat2, 1.2)
    print(f"\nGOF on bridge-generated path:")
    print(f"  jacobi_qlike: {gof_br['jacobi_qlike']:.4f}")
    print(f"  bridge_qlike: {gof_br['bridge_qlike']:.4f}")
    print(f"  ratio (J/B):  {gof_br['ratio']}")
    print(f"  winner:       {gof_br['winner']}")
    print(f"  advantage:    {gof_br['advantage_pct']:.1f}%")
