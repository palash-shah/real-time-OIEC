"""
diag_pll.py — print per-market, per-tick PLL breakdown for eligible markets.

Run from the backend folder while main.py is also running:
    python diag_pll.py

It hits the local backend's /data.json and prints a detailed breakdown of
every eligible market's PLL accounting:
  - n_smooth ticks, mean PLL bridge / Jacobi on smooth
  - n_jump ticks, mean PLL bridge / Jacobi on jumps
  - σ_J calibrated, β₀ calibrated
  - Predicted variance ratios

This tells us whether the bridge is losing because:
  (a) σ_J calibration is too tight (Jacobi unrealistically confident on smooth)
  (b) β₀ calibration is too loose (Bridge too wide on smooth)
  (c) Few/weak jumps that don't compensate
  (d) Jump-only PLL is also negative (bridge isn't actually handling jumps well)
"""

import json
import math
import sys
from urllib import request, error

SECY = 365.25 * 86400


def fetch_data():
    try:
        with request.urlopen("http://localhost:8000/data.json", timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))
    except (error.URLError, error.HTTPError) as e:
        print(f"[!] Could not reach localhost:8000 — is main.py running? ({e})")
        sys.exit(1)


def log_normal_pdf(x, sigma):
    if sigma <= 1e-18:
        return -1e18
    z = x / sigma
    return -0.5 * z * z - math.log(sigma) - 0.5 * math.log(2 * math.pi)


def diagnose_market(m):
    """Recompute PLL breakdown from scratch using the market's payload."""
    pin = m.get("pinning") or {}
    gof = m.get("gof") or {}
    name = m.get("name", "?")[:55]
    if not gof.get("eligible"):
        return None

    sigma_J = float(m.get("sigma_hat", 0)) or 1.0
    beta0 = float(gof.get("beta0_calibrated", 0)) or float(pin.get("beta0", 0)) or 1.0
    ttr_years = float(m.get("time_to_resolution_years", 0))

    history_prices = m.get("history_prices", [])
    history_ts_iso = m.get("history_timestamps", [])
    if len(history_prices) != len(history_ts_iso) or len(history_prices) < 16:
        return None

    # Convert ISO timestamps to unix seconds
    from datetime import datetime
    ts = []
    for t_iso in history_ts_iso:
        try:
            ts.append(datetime.fromisoformat(t_iso.replace("Z", "+00:00")).timestamp())
        except Exception:
            ts.append(None)
    if any(t is None for t in ts):
        return None

    n = len(history_prices)
    split = n // 2
    t_latest = ts[-1]

    smooth_b_pll = []
    smooth_j_pll = []
    jump_b_pll = []
    jump_j_pll = []
    smooth_var_ratio = []  # bridge_var / jacobi_var
    realized_zs = []

    for i in range(split, n):
        if i == 0:
            continue
        dt_yr = (ts[i] - ts[i-1]) / SECY
        if dt_yr <= 0:
            continue
        p_now = max(min(history_prices[i], 1 - 1e-4), 1e-4)
        p_prev = max(min(history_prices[i-1], 1 - 1e-4), 1e-4)
        dL = math.log(p_now/(1-p_now)) - math.log(p_prev/(1-p_prev))
        if abs(dL) < 1e-10:
            continue

        p_q = max(p_prev * (1 - p_prev), 1e-6)

        # Variance predictions in L-space
        var_J_L = (sigma_J * sigma_J) / p_q * dt_yr

        age_now = (t_latest - ts[i]) / SECY
        age_prev = (t_latest - ts[i-1]) / SECY
        rem_now = ttr_years + age_now
        rem_prev = ttr_years + age_prev
        d_lam = math.log(rem_prev / max(rem_now, 1e-12))
        var_B_L = (beta0 ** 2) * max(d_lam, 1e-12)

        # PLL
        pllJ = log_normal_pdf(dL, math.sqrt(var_J_L))
        pllB = log_normal_pdf(dL, math.sqrt(var_B_L))
        if not (math.isfinite(pllJ) and math.isfinite(pllB)):
            continue

        # Jump detection
        z_J = abs(dL) / math.sqrt(var_J_L) if var_J_L > 0 else 0
        realized_zs.append(z_J)

        if z_J > 3.0:
            jump_b_pll.append(pllB)
            jump_j_pll.append(pllJ)
        else:
            smooth_b_pll.append(pllB)
            smooth_j_pll.append(pllJ)
            smooth_var_ratio.append(var_B_L / var_J_L)

    return {
        "name": name,
        "sigma_J": sigma_J,
        "beta0": beta0,
        "ttr_days": ttr_years * 365.25,
        "n_smooth": len(smooth_b_pll),
        "n_jump": len(jump_b_pll),
        "smooth_pll_B": sum(smooth_b_pll) / max(len(smooth_b_pll), 1),
        "smooth_pll_J": sum(smooth_j_pll) / max(len(smooth_j_pll), 1),
        "jump_pll_B":   sum(jump_b_pll) / max(len(jump_b_pll), 1) if jump_b_pll else None,
        "jump_pll_J":   sum(jump_j_pll) / max(len(jump_j_pll), 1) if jump_j_pll else None,
        "var_ratio":    sum(smooth_var_ratio) / max(len(smooth_var_ratio), 1),
        "max_z":        max(realized_zs) if realized_zs else 0,
        "p99_z":        sorted(realized_zs)[int(len(realized_zs)*0.99)] if realized_zs else 0,
        # Reported by backend (compare against my recomputed values)
        "reported_B_pll": gof.get("bridge_pll"),
        "reported_J_pll": gof.get("jacobi_pll"),
        "reported_jumps": gof.get("n_jump_ticks"),
        "reported_med":   gof.get("median_pll_advantage"),
    }


def main():
    data = fetch_data()
    markets = data.get("markets", [])
    print(f"Backend tick: {data.get('_meta', {}).get('tick')}")
    print(f"Markets in payload: {len(markets)}")
    eligible = [m for m in markets if m.get("gof", {}).get("eligible")]
    print(f"Eligible: {len(eligible)}")
    print()

    if not eligible:
        print("No eligible markets — nothing to diagnose.")
        return

    for m in eligible:
        d = diagnose_market(m)
        if d is None:
            continue
        print(f"=== {d['name']} ({d['ttr_days']:.1f}d) ===")
        print(f"  σ_J calibrated:    {d['sigma_J']:.4f}")
        print(f"  β₀ calibrated:     {d['beta0']:.4f}  "
              f"({'OK' if 0.1 < d['beta0'] < 5.0 else 'EXTREME'})")
        print(f"  Bridge/Jacobi var ratio (smooth ticks): {d['var_ratio']:.2f}x")
        print(f"  Max realized z under Jacobi: {d['max_z']:.2f}σ  "
              f"(p99: {d['p99_z']:.2f}σ)")
        print()
        print(f"  SMOOTH ticks (z<3): {d['n_smooth']}")
        if d['n_smooth'] > 0:
            print(f"    mean PLL_B:  {d['smooth_pll_B']:>+8.3f}")
            print(f"    mean PLL_J:  {d['smooth_pll_J']:>+8.3f}")
            print(f"    Δ (B-J):     {d['smooth_pll_B'] - d['smooth_pll_J']:>+8.3f}")
        print(f"  JUMP ticks (z>=3): {d['n_jump']}")
        if d['n_jump'] > 0:
            print(f"    mean PLL_B:  {d['jump_pll_B']:>+8.3f}")
            print(f"    mean PLL_J:  {d['jump_pll_J']:>+8.3f}")
            print(f"    Δ (B-J):     {d['jump_pll_B'] - d['jump_pll_J']:>+8.3f}")
        print()
        print(f"  Reported by backend: B={d['reported_B_pll']}  J={d['reported_J_pll']}  "
              f"jumps={d['reported_jumps']}  med_Δ={d['reported_med']}")
        print()
        print("-" * 70)


if __name__ == "__main__":
    main()
