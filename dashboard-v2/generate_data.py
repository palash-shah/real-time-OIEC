"""
Generate a realistic data.json for the OIEC dashboard demo.

Uses a Jacobi diffusion model:  dP = sigma * sqrt(P*(1-P)) dW
For demo purposes we approximate call/put option prices and Greeks on an
event future P in [0,1] with a bounded-variance approximation. Values are
internally consistent (put-call parity where applicable, Greeks monotone,
BVIX ~ sigma * sqrt(tau) in an annualised sense) so drill-downs look real.
"""

import json
import math
from datetime import datetime, timedelta, timezone
import random

random.seed(7)


def bs_like_call(P, K, sigma, tau):
    # Bachelier-style approximation appropriate for bounded [0,1] processes
    # in the interior of the simplex. Good enough for demo visuals.
    sd = sigma * math.sqrt(max(P * (1 - P), 1e-6)) * math.sqrt(max(tau, 1e-6))
    if sd < 1e-8:
        return max(P - K, 0.0)
    d = (P - K) / sd
    # standard normal pdf / cdf
    pdf = math.exp(-0.5 * d * d) / math.sqrt(2 * math.pi)
    cdf = 0.5 * (1 + math.erf(d / math.sqrt(2)))
    price = (P - K) * cdf + sd * pdf
    return max(price, 0.0)


def bs_like_put(P, K, sigma, tau):
    # Put-call parity on the event future: C - P_opt = P - K
    c = bs_like_call(P, K, sigma, tau)
    return max(c - (P - K), 0.0)


def greeks(P, K, sigma, tau):
    sd = sigma * math.sqrt(max(P * (1 - P), 1e-6)) * math.sqrt(max(tau, 1e-6))
    if sd < 1e-8:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    d = (P - K) / sd
    pdf = math.exp(-0.5 * d * d) / math.sqrt(2 * math.pi)
    cdf = 0.5 * (1 + math.erf(d / math.sqrt(2)))
    delta_c = cdf
    delta_p = cdf - 1.0
    gamma = pdf / sd
    vega = pdf * math.sqrt(max(P * (1 - P), 1e-6)) * math.sqrt(max(tau, 1e-6))
    theta = -0.5 * sigma * math.sqrt(max(P * (1 - P), 1e-6)) * pdf / math.sqrt(max(tau, 1e-6))
    return delta_c, delta_p, gamma, vega, theta


def simulate_history(P0, sigma, days, drift=0.0):
    """Simulate a Jacobi-like path over `days` trading days, one point per day."""
    dt = 1 / 365.0
    p = P0
    out = [p]
    for _ in range(days - 1):
        diffusion = sigma * math.sqrt(max(p * (1 - p), 1e-6)) * math.sqrt(dt) * random.gauss(0, 1)
        p = min(max(p + drift * dt + diffusion, 0.01), 0.99)
        out.append(p)
    return out


def build_market(name, platform, current_price, ttr_years, sigma_hat, tau,
                 spread_before_cents, compression, history_days=150,
                 scheduled_events=None, history_drift=0.0):
    strikes = [round(x * 0.05, 2) for x in range(1, 20)]  # 0.05..0.95
    call_prices = [round(bs_like_call(current_price, k, sigma_hat, tau), 4) for k in strikes]
    put_prices = [round(bs_like_put(current_price, k, sigma_hat, tau), 4) for k in strikes]

    delta_c, delta_p, gamma_l, vega_l, theta_l = [], [], [], [], []
    for k in strikes:
        dc, dp, g, v, t = greeks(current_price, k, sigma_hat, tau)
        delta_c.append(round(dc, 4))
        delta_p.append(round(dp, 4))
        gamma_l.append(round(g, 4))
        vega_l.append(round(v, 4))
        theta_l.append(round(t, 4))

    variance_swap_strike = round(sigma_hat ** 2 * tau, 4)
    bvix_model_based = round(sigma_hat * math.sqrt(tau) * 0.94, 3)
    bvix_model_free = round(sigma_hat * math.sqrt(tau) * 0.86, 3)

    # History: backfill to today
    now = datetime.now(timezone.utc).replace(microsecond=0, second=0, minute=0)
    timestamps = [(now - timedelta(days=history_days - 1 - i)).isoformat() for i in range(history_days)]
    # End the simulated path at current_price
    history = simulate_history(current_price * 0.92 if history_drift >= 0 else current_price * 1.08,
                               sigma_hat, history_days, drift=history_drift)
    # Nudge the last value toward current_price for visual coherence
    history[-1] = current_price
    history = [round(x, 4) for x in history]

    # Economics (paper's framing: capital-efficiency via shortened lockup)
    #
    # Before OIECs:
    #   An arbitrageur posts collateral C to capture a $s_before spread and
    #   holds until resolution. Annualised return = s_before / ttr.
    #
    # After OIECs:
    #   The SAME opportunity is closed at the nearest OIEC expiry (horizon tau).
    #   Capital recycles ttr/tau times over the original horizon, so even a
    #   much tighter quoted spread s_after translates to a far higher
    #   annualised return: s_after / tau, with (ttr/tau) >> 1.
    #   Meanwhile quoted spreads compress toward their no-arbitrage bound.
    #
    # `compression_factor` here is the SPREAD compression ratio (visible
    # market symptom). The annualised-return ratio is the operational
    # consequence and is typically larger still.
    spread_after_cents = round(spread_before_cents / compression, 4)
    ann_return_before = round((spread_before_cents / 100.0) / ttr_years, 4)
    ann_return_after  = round((spread_after_cents  / 100.0) / tau, 4)
    effective_compression = round(compression, 1)

    return {
        "name": name,
        "platform": platform,
        "current_price": current_price,
        "time_to_resolution_years": ttr_years,
        "sigma_hat": sigma_hat,
        "tau": tau,
        "strikes": strikes,
        "call_prices": call_prices,
        "put_prices": put_prices,
        "delta_c": delta_c,
        "delta_p": delta_p,
        "gamma": gamma_l,
        "vega": vega_l,
        "theta": theta_l,
        "variance_swap_strike": variance_swap_strike,
        "bvix_model_based": bvix_model_based,
        "bvix_model_free": bvix_model_free,
        "history_timestamps": timestamps,
        "history_prices": history,
        "scheduled_events": scheduled_events or [],
        "cross_platform_spread_cents": spread_before_cents,
        "arbitrage": {
            "spread_before_cents": spread_before_cents,
            "spread_after_cents": spread_after_cents,
            "compression_factor": effective_compression,
            "annualized_return_before": ann_return_before,
            "annualized_return_after": ann_return_after,
        },
    }


markets = [
    build_market(
        name="2028 US Presidential Election — Democrat wins",
        platform="Polymarket",
        current_price=0.47,
        ttr_years=2.00,
        sigma_hat=1.004,
        tau=0.25,
        spread_before_cents=4.5,
        compression=104.3,
        history_drift=0.08,
        scheduled_events=[
            ["First primary debate", (datetime.now(timezone.utc) + timedelta(days=85)).isoformat()],
            ["Iowa caucus", (datetime.now(timezone.utc) + timedelta(days=220)).isoformat()],
            ["Super Tuesday", (datetime.now(timezone.utc) + timedelta(days=280)).isoformat()],
        ],
    ),
    build_market(
        name="Fed cuts rates by 25bp at next FOMC",
        platform="Kalshi",
        current_price=0.68,
        ttr_years=0.12,
        sigma_hat=0.82,
        tau=0.08,
        spread_before_cents=2.1,
        compression=52.5,
        history_drift=0.30,
        scheduled_events=[
            ["FOMC statement", (datetime.now(timezone.utc) + timedelta(days=44)).isoformat()],
            ["CPI release", (datetime.now(timezone.utc) + timedelta(days=12)).isoformat()],
        ],
    ),
    build_market(
        name="ETH > $5,000 by Dec 31",
        platform="Polymarket",
        current_price=0.34,
        ttr_years=0.64,
        sigma_hat=1.21,
        tau=0.17,
        spread_before_cents=3.2,
        compression=81.0,
        history_drift=-0.15,
        scheduled_events=[
            ["Pectra upgrade mainnet", (datetime.now(timezone.utc) + timedelta(days=60)).isoformat()],
        ],
    ),
    build_market(
        name="OpenAI releases GPT-6 before 2027",
        platform="Manifold",
        current_price=0.23,
        ttr_years=0.88,
        sigma_hat=0.91,
        tau=0.22,
        spread_before_cents=5.8,
        compression=118.2,
        history_drift=-0.05,
        scheduled_events=[
            ["OpenAI DevDay", (datetime.now(timezone.utc) + timedelta(days=95)).isoformat()],
        ],
    ),
]

data = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "markets": markets,
}

with open("/home/claude/dashboard/data.json", "w") as f:
    json.dump(data, f, indent=2)

print("Wrote data.json with", len(markets), "markets")
print("Size:", )
import os
print(os.path.getsize("/home/claude/dashboard/data.json"), "bytes")
