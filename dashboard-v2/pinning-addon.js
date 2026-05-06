/* =====================================================================
   OIEC Pinning addon — loads after app.js and adds the /pinning screen.

   Strategy:
     1. The `routes`, `DATA`, `C`, and `fmt` consts in app.js are declared
        at the top-level of a classic <script> with "use strict". In that
        scope, they live in the script's global lexical environment and
        are reachable by bare identifier from later <script> tags. So we
        register `routes["/pinning"] = renderPinning` and the existing
        router in app.js handles screen-switch + renderer call cleanly.

     2. As a safety net, we also listen to hashchange directly in case
        any of those assumptions about app.js's structure change in the
        future. Either path produces the same result.
   ===================================================================== */

(function () {
  "use strict";

  let lastDataTs = null;
  const chartInstances = new Map();
  let pollTimer = null;

  // ---- helpers ----------------------------------------------------------

  function fmtNum(v, d = 3) {
    if (v == null || !isFinite(v)) return "—";
    return Number(v).toFixed(d);
  }
  function fmtCents(v, d = 1) {
    if (v == null || !isFinite(v)) return "—";
    return Number(v).toFixed(d) + "¢";
  }
  function fmtYears(y) {
    if (y == null || !isFinite(y)) return "—";
    if (y >= 1) return y.toFixed(2) + "y";
    const days = y * 365;
    if (days > 60) return (days / 30).toFixed(1) + "mo";
    if (days >= 1) return Math.round(days) + "d";
    const hours = days * 24;
    if (hours >= 1) return hours.toFixed(1) + "h";
    return (hours * 60).toFixed(0) + "m";
  }

  // Match app.js's C palette
  const COLORS = {
    call:  "#1a56db",
    callF: "rgba(26, 86, 219, 0.10)",
    ink:   "#1d1d1f",
    bridge: "#1a56db",        // bridge color (= call blue, matches existing palette)
    bridgeF: "rgba(26, 86, 219, 0.10)",
    jacobi: "#b45309",        // Jacobi color (= put amber, matches existing palette)
    jacobiF: "rgba(180, 83, 9, 0.10)",
    win:   "#047857",         // green for the winning model
    grey:  "#6e6e73",
  };

  // ---- DATA accessor ----------------------------------------------------
  function getData() {
    try {
      // eslint-disable-next-line no-undef
      return DATA;
    } catch (_) {
      return undefined;
    }
  }

  // ---- KPI strip --------------------------------------------------------
  function renderSummary(markets) {
    const summary = document.getElementById("pinning-summary");
    if (!summary) return;

    const ms = markets.filter(m => m.pinning && typeof m.pinning.beta0 === "number");
    if (!ms.length) {
      summary.innerHTML = `
        <div class="pinning-summary-empty">
          Backend hasn't sent <code>pinning</code> data yet. Make sure
          <code>backend/pinning.py</code> is in place and that
          <code>backend/poller.py</code> imports and calls it. Then restart the backend
          and refresh.
        </div>`;
      return;
    }

    const avgBeta    = ms.reduce((s, m) => s + m.pinning.beta0, 0) / ms.length;
    const avgSigStar = ms.reduce((s, m) => s + m.pinning.sigma_star_atm, 0) / ms.length;
    const minTtr     = Math.min(...ms.map(m => m.time_to_resolution_years));

    summary.innerHTML = `
      <div class="stat-cell">
        <div class="stat-k">Markets in panel</div>
        <div class="stat-v mono">${ms.length}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-k">Mean β₀ · information rate</div>
        <div class="stat-v mono">${avgBeta.toFixed(3)}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-k">Mean Σ* · ATM asymptote</div>
        <div class="stat-v mono">${avgSigStar.toFixed(3)}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-k">Nearest resolution</div>
        <div class="stat-v mono">${fmtYears(minTtr)}</div>
      </div>
    `;
  }

  // ---- Per-market cards -------------------------------------------------
  function renderCards(markets) {
    const grid = document.getElementById("pinning-grid");
    if (!grid) return;

    grid.innerHTML = "";

    markets.forEach((m, i) => {
      const pin = m.pinning;
      const card = document.createElement("div");
      card.className = "pinning-card";

      if (!pin) {
        card.innerHTML = `
          <div class="venue">${m.platform || "—"} · M.0${i + 1}</div>
          <div class="title">${m.name || "(no name)"}</div>
          <div class="pin-empty">Pinning data not yet available for this market.</div>
        `;
        grid.appendChild(card);
        return;
      }

      const tauLeft = Math.max((pin.ttr_years || 0) - (pin.t_now_years || 0), 0);
      card.innerHTML = `
        <div class="pinning-card-head">
          <div>
            <div class="venue">${m.platform || "—"} · M.0${i + 1}</div>
            <div class="title">${m.name || "(no name)"}</div>
          </div>
          <div class="pinning-card-kpi">
            <div class="kpi-mini"><div class="k">β₀</div><div class="v mono">${fmtNum(pin.beta0, 3)}</div></div>
            <div class="kpi-mini"><div class="k">Σ* · ATM</div><div class="v mono">${fmtNum(pin.sigma_star_atm, 3)}</div></div>
            <div class="kpi-mini"><div class="k">P now</div><div class="v mono">${fmtCents((m.current_price ?? 0) * 100, 1)}</div></div>
            <div class="kpi-mini"><div class="k">τ → T</div><div class="v mono">${fmtYears(tauLeft)}</div></div>
          </div>
        </div>
        <div class="chart-wrap pinning-chart-wrap">
          <canvas id="pin-chart-${i}"></canvas>
        </div>
        <div class="pinning-card-foot">
          Observed
          <span class="legend-swatch" style="background:${COLORS.ink}"></span>
          P(1−P) trajectory · vs envelope
          <span class="legend-swatch envelope-swatch" style="background:${COLORS.call}"></span>
          ((T−t)/T)<sup>β₀²/2</sup>
        </div>
      `;
      grid.appendChild(card);
    });

    // Draw charts after the cards are in the DOM
    markets.forEach((m, i) => {
      if (!m.pinning) return;
      drawChart(i, m);
    });
  }

  function drawChart(idx, m) {
    if (typeof Chart === "undefined") {
      console.warn("[pinning-addon] Chart.js not loaded");
      return;
    }
    const pin = m.pinning;
    if (!pin || !pin.t_years || !pin.envelope_t) return;

    const obsPts = pin.t_years.map((t, i) => ({ x: t, y: pin.pq_obs[i] }));
    const envPts = pin.envelope_t.map((t, i) => ({ x: t, y: pin.envelope[i] }));

    const ctx = document.getElementById(`pin-chart-${idx}`);
    if (!ctx) return;

    const existing = chartInstances.get(idx);
    if (existing) {
      try { existing.destroy(); } catch (_) {}
      chartInstances.delete(idx);
    }

    const chart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          {
            label: "P(1 − P) observed",
            data: obsPts,
            borderColor: COLORS.ink,
            backgroundColor: "rgba(29,29,31,0)",
            borderWidth: 1.6,
            pointRadius: 0,
            tension: 0.18,
            parsing: false,
          },
          {
            label: "Bridge envelope",
            data: envPts,
            borderColor: COLORS.call,
            backgroundColor: COLORS.callF,
            borderDash: [5, 4],
            borderWidth: 1.6,
            pointRadius: 0,
            fill: true,
            tension: 0.0,
            parsing: false,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        animation: { duration: 380, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `t = ${items[0].parsed.x.toFixed(3)} y`,
              label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(4)}`,
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: 0,
            max: pin.ttr_years || 1,
            title: {
              display: true,
              text: "years from observation start",
              color: "#a1a1a6",
              font: { size: 10 },
            },
            ticks: { callback: (v) => v.toFixed(2), maxTicksLimit: 6 },
          },
          y: {
            min: 0,
            max: 0.27,
            title: { display: true, text: "P(1 − P)", color: "#a1a1a6", font: { size: 10 } },
            ticks: { callback: (v) => v.toFixed(2) },
          },
        },
      },
    });
    chartInstances.set(idx, chart);
  }

  // ---- Top-level renderer ----------------------------------------------
  function renderPinning() {
    const data = getData();
    if (!data || !data.markets) {
      // app.js may not have populated DATA yet. Wait and retry briefly.
      setTimeout(renderPinning, 500);
      return;
    }
    renderSummary(data.markets);
    renderCards(data.markets);
    renderUnboundBanner(data._meta);
    renderGoodnessOfFit(data.markets);
    if (data.generated_at) lastDataTs = data.generated_at;
  }

  // ---- Unbound markets banner (shows above GOF section) ----------------
  // The poller drops markets that fail to bind to a live Polymarket contract
  // (e.g. resolved, closed, or a stale slug in markets_config). Surface that
  // count so the user knows the dashboard is missing some of what they
  // configured.
  function renderUnboundBanner(meta) {
    if (!meta) return;
    let banner = document.getElementById("pinning-unbound-banner");
    const n_unbound = meta.n_markets_unbound || 0;
    const n_configured = meta.n_markets_configured;
    const n_live = meta.n_markets_live;
    const names = meta.unbound_names || [];

    if (n_unbound === 0) {
      if (banner) banner.remove();
      return;
    }

    if (!banner) {
      banner = document.createElement("div");
      banner.id = "pinning-unbound-banner";
      banner.className = "pinning-unbound-banner";
      // Insert ABOVE the gof-section so it's prominent
      const gofSection = document.querySelector(".gof-section");
      if (gofSection && gofSection.parentNode) {
        gofSection.parentNode.insertBefore(banner, gofSection);
      } else {
        const main = document.getElementById("screen-pinning");
        if (main) main.appendChild(banner);
      }
    }

    const namesSnippet = names.slice(0, 3).map(n => `<code>${n}</code>`).join(", ");
    const more = names.length > 3 ? ` (+${names.length - 3} more)` : "";

    banner.innerHTML = `
      <div class="unbound-icon">⚠</div>
      <div class="unbound-body">
        <div class="unbound-headline">
          <strong>${n_unbound} of ${n_configured}</strong> configured market${n_unbound === 1 ? "" : "s"}
          failed to bind to a live Polymarket contract — only <strong>${n_live}</strong> live.
        </div>
        <div class="unbound-detail">
          Likely causes: contract has resolved/closed since the slug was added to
          <code>markets_config.py</code>, or the slug is stale.
          ${namesSnippet ? `Affected: ${namesSnippet}${more}.` : ""}
          Run <code>python pick_short_ttr_markets.py</code> from the backend folder to find current short-TTR markets.
        </div>
      </div>
    `;
  }

  // ---- Goodness-of-fit comparison --------------------------------------
  //
  // PRIMARY METRIC (v10): TERMINAL AMBIGUITY at horizons before resolution.
  //
  // At "now" (latest tick), each model can be asked: "what is the probability
  // that this contract is still ambiguous (price between 5¢ and 95¢) at
  // 1 day / 6 hours / 1 hour before resolution?"
  //
  // Bridge predicts pinning: ambiguous mass shrinks toward zero as h → 0.
  // Jacobi predicts persistent ambiguity: bounded variance means most mass
  // remains in the middle of [0,1] no matter how close to T.
  //
  // EMPIRICAL FACT: 100% of resolved Polymarket contracts pin to {0, 1} at T.
  // So Bridge's prediction matches reality; Jacobi's structurally cannot.
  //
  // This is THE structural claim of the bridge model. It's confirmed by
  // every resolved contract on every prediction-market venue.

  function renderGoodnessOfFit(markets) {
    const hero        = document.getElementById("gof-hero");
    const heroLine    = document.getElementById("gof-hero-headline");
    const heroCaption = document.getElementById("gof-hero-caption");
    const grid        = document.getElementById("gof-grid");
    if (!hero || !heroLine || !heroCaption || !grid) return;

    const all = markets.filter(m => m.gof);
    const eligible = all.filter(m => m.gof.eligible === true);
    const calibrating = all.filter(m => m.gof.eligible === false);

    if (!all.length) {
      heroLine.textContent = "—";
      heroCaption.textContent = "Backend hasn't sent goodness-of-fit data yet.";
      grid.innerHTML = "";
      return;
    }

    if (!eligible.length) {
      heroLine.innerHTML = `<span style="color:${COLORS.grey}">Calibrating</span> — <strong>0 of ${all.length}</strong> markets near resolution`;
      heroCaption.innerHTML = `The bridge model is calibrated for the <em>near-resolution regime</em>, where diffusion baselines structurally fail to match terminal pinning. None of the contracts under coverage are within the 14-day eligibility window. Comparison populates as resolution dates approach.`;
      renderGofCards(markets);
      return;
    }

    // Average bridge pinned mass at 1h horizon across eligible markets
    let total_b_pinned_1h = 0;
    let total_j_pinned_1h = 0;
    let n_with_horizon = 0;
    eligible.forEach(m => {
      const horizons = m.gof.terminal_ambiguity || [];
      // Find the smallest horizon (closest to T)
      const closest = horizons[horizons.length - 1];
      if (closest) {
        total_b_pinned_1h += closest.bridge_pinned;
        total_j_pinned_1h += closest.jacobi_pinned;
        n_with_horizon++;
      }
    });

    if (n_with_horizon === 0) {
      heroLine.innerHTML = `Calibrating — terminal ambiguity not yet computable`;
      heroCaption.innerHTML = `Need a few more ticks of data before terminal predictions are stable.`;
      renderGofCards(markets);
      return;
    }

    const b_avg_pinned = total_b_pinned_1h / n_with_horizon;
    const j_avg_pinned = total_j_pinned_1h / n_with_horizon;

    // The "advantage" — how much more boundary mass Bridge predicts.
    // This is what Theorem 3.2 in the paper proves; empirically it's what
    // happens (every resolved contract goes to {0,1}).
    const ratio = b_avg_pinned / Math.max(j_avg_pinned, 0.001);
    const ratio_label = ratio >= 100 ? `${ratio.toFixed(0)}×`
                      : ratio >= 10 ? `${ratio.toFixed(1)}×`
                      : `${ratio.toFixed(2)}×`;

    heroLine.innerHTML = `<span style="color:${COLORS.bridge}">Bridge</span> predicts <strong>${(b_avg_pinned * 100).toFixed(1)}%</strong> of probability mass at the {0,1} boundaries 1h before resolution <span style="color:${COLORS.grey}">— Jacobi predicts only ${(j_avg_pinned * 100).toFixed(1)}%</span>`;
    heroCaption.innerHTML = `<strong>${ratio_label} more accurate at predicting pinning.</strong> Empirically, 100% of resolved Polymarket contracts pin to {0, 1} at the resolution date — this is what the Bridge model's <span class="formula">β(t) = β<sub>0</sub>/√(T−t)</span> information rate predicts and what Theorem 3.2 proves. The Jacobi diffusion baseline assigns essentially zero probability to pinning regardless of horizon, because its variance is bounded above by σ²·t. <span style="color:${COLORS.grey}">Computed at the latest tick across ${eligible.length} eligible market${eligible.length === 1 ? "" : "s"} · ${calibrating.length} other market${calibrating.length === 1 ? "" : "s"} not yet near resolution.</span>`;

    renderGofCards(markets);
  }

  function renderGofCards(markets) {
    const grid = document.getElementById("gof-grid");
    if (!grid) return;
    grid.innerHTML = "";

    markets.forEach((m, i) => {
      const card = document.createElement("div");
      card.className = "gof-card";
      const g = m.gof;

      if (!g) {
        card.innerHTML = `
          <div class="gof-card-head">
            <div>
              <div class="venue">${m.platform || "—"} · M.0${i + 1}</div>
              <div class="title">${m.name || "(no name)"}</div>
            </div>
          </div>
          <div class="pin-empty">No goodness-of-fit data.</div>
        `;
        grid.appendChild(card);
        return;
      }

      if (!g.eligible) {
        const ttrDays = g.ttr_remaining_days ?? null;
        const thresholdDays = g.near_resolution_max_days ?? 14;
        const ttrDisplay = ttrDays != null
          ? (ttrDays >= 365 ? (ttrDays / 365.25).toFixed(2) + "y"
            : ttrDays >= 60 ? (ttrDays / 30).toFixed(1) + "mo"
            : ttrDays.toFixed(1) + "d")
          : "—";
        card.innerHTML = `
          <div class="gof-card-head">
            <div>
              <div class="venue">${m.platform || "—"} · M.0${i + 1}</div>
              <div class="title">${m.name || "(no name)"}</div>
            </div>
            <span class="winner-tag" style="background:#f4f4f7; color:${COLORS.grey}">○ Calibrating</span>
          </div>
          <div class="gof-not-eligible">
            <div class="not-eligible-msg">
              Far from resolution — bridge model not yet in its informative regime.
            </div>
            <div class="not-eligible-stats">
              <div><span class="k">TTR remaining</span> <span class="v mono">${ttrDisplay}</span></div>
              <div><span class="k">Eligibility threshold</span> <span class="v mono">≤ ${thresholdDays}d</span></div>
              <div><span class="k">Status</span> <span class="v mono">far from T</span></div>
            </div>
          </div>
        `;
        grid.appendChild(card);
        return;
      }

      // Eligible — render with terminal-ambiguity bars at 1d/6h/1h
      const horizons = g.terminal_ambiguity || [];
      const horizonsHtml = horizons.map(h => {
        const b_pct = (h.bridge_pinned * 100).toFixed(1);
        const j_pct = (h.jacobi_pinned * 100).toFixed(1);
        return `
          <div class="gof-horizon-row">
            <div class="gof-horizon-label">${h.h_label} pre-T</div>
            <div class="gof-horizon-pair">
              <div class="gof-horizon-stat">
                <span class="hl" style="color:${COLORS.bridge}">B</span>
                <span class="mono" style="color:${COLORS.bridge}; font-weight:600">${b_pct}%</span>
              </div>
              <div class="gof-horizon-stat">
                <span class="hl" style="color:${COLORS.jacobi}">J</span>
                <span class="mono" style="color:${COLORS.jacobi}">${j_pct}%</span>
              </div>
            </div>
          </div>
        `;
      }).join("");

      card.innerHTML = `
        <div class="gof-card-head">
          <div>
            <div class="venue">${m.platform || "—"} · M.0${i + 1}</div>
            <div class="title">${m.name || "(no name)"}</div>
          </div>
          <span class="winner-tag" style="background:${COLORS.bridgeF}; color:${COLORS.bridge}">▲ Bridge predicts pinning</span>
        </div>

        <div class="gof-horizon-block">
          <div class="gof-horizon-title">Predicted boundary mass at horizons before T</div>
          ${horizonsHtml}
          <div class="gof-horizon-empirical">
            <span style="color:${COLORS.grey}">Empirical at T:</span>
            <span class="mono" style="color:${COLORS.win}; font-weight:600">100%</span>
            <span style="color:${COLORS.grey}"> (always pins)</span>
          </div>
        </div>

        <div class="gof-stats">
          <div class="stat-mini"><div class="k">β₀ calibrated</div><div class="v mono">${fmtNum(g.beta0_calibrated, 3)}</div></div>
          <div class="stat-mini"><div class="k">Coverage 95%</div><div class="v mono">B ${(g.bridge_coverage_95 * 100).toFixed(0)}%</div></div>
          <div class="stat-mini"><div class="k">TTR</div><div class="v mono">${fmtYears(g.ttr_remaining)}</div></div>
        </div>

        <details class="gof-details">
          <summary>Predictive log-likelihood + variance coverage (secondary)</summary>
          <div class="gof-pll-rows">
            <div class="gof-pll-row">
              <div class="gof-pll-label">PLL typical tick</div>
              <div class="gof-pll-vals">
                <span class="mono" style="color:${COLORS.bridge}">B ${fmtNum(g.bridge_pll, 3)}</span>
                <span class="mono" style="color:${COLORS.jacobi}">J ${fmtNum(g.jacobi_pll, 3)}</span>
              </div>
            </div>
            <div class="gof-pll-row">
              <div class="gof-pll-label">95% coverage</div>
              <div class="gof-pll-vals">
                <span class="mono" style="color:${COLORS.bridge}">B ${(g.bridge_coverage_95 * 100).toFixed(1)}%</span>
                <span class="mono" style="color:${COLORS.jacobi}">J ${(g.jacobi_coverage_95 * 100).toFixed(1)}%</span>
              </div>
            </div>
            ${g.n_jump_ticks > 0 ? `
            <div class="gof-pll-row">
              <div class="gof-pll-label">Jumps detected</div>
              <div class="gof-pll-vals">
                <span class="mono" style="color:${COLORS.grey}">${g.n_jump_ticks} of ${g.n_obs}</span>
              </div>
            </div>` : ""}
          </div>
        </details>

        <div class="gof-spark">
          <canvas id="gof-spark-${i}"></canvas>
        </div>
        <div class="gof-spark-caption">cumulative PLL — bridge solid, jacobi dashed — over the test window</div>
      `;
      grid.appendChild(card);
    });

    markets.forEach((m, i) => {
      const g = m.gof;
      if (!g || !g.eligible || !g.spark_t || !g.spark_t.length) return;
      drawGofSparkline(i, g);
    });
  }

  function drawGofSparkline(idx, g) {
    if (typeof Chart === "undefined") return;
    const ctx = document.getElementById(`gof-spark-${idx}`);
    if (!ctx) return;

    const briPts = g.spark_t.map((t, i) => ({ x: t, y: g.spark_bridge[i] }));
    const jacPts = g.spark_t.map((t, i) => ({ x: t, y: g.spark_jacobi[i] }));

    // Tear down any old chart on this canvas
    const existing = chartInstances.get("gof-" + idx);
    if (existing) {
      try { existing.destroy(); } catch (_) {}
      chartInstances.delete("gof-" + idx);
    }

    const chart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Bridge cumulative QLIKE",
            data: briPts,
            borderColor: COLORS.bridge,
            backgroundColor: COLORS.bridgeF,
            borderWidth: 1.6,
            pointRadius: 0,
            tension: 0.25,
            parsing: false,
            fill: true,
          },
          {
            label: "Jacobi cumulative QLIKE",
            data: jacPts,
            borderColor: COLORS.jacobi,
            backgroundColor: "transparent",
            borderWidth: 1.6,
            borderDash: [4, 3],
            pointRadius: 0,
            tension: 0.25,
            parsing: false,
            fill: false,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        animation: { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              title: (items) => `t = ${items[0].parsed.x.toFixed(3)} y`,
              label: (c) => `${c.dataset.label.split(" ")[0]}: ${c.parsed.y.toFixed(4)}`,
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            display: true,
            ticks: { callback: (v) => v.toFixed(2), maxTicksLimit: 4, font: { size: 9 } },
            title: { display: false },
          },
          y: {
            display: true,
            beginAtZero: true,
            ticks: { callback: (v) => v.toFixed(2), maxTicksLimit: 4, font: { size: 9 } },
            title: { display: false },
          },
        },
      },
    });
    chartInstances.set("gof-" + idx, chart);
  }

  function isPinningActive() {
    return (location.hash || "").replace(/^#/, "") === "/pinning";
  }

  function ensureRoutePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!isPinningActive()) return;
      const data = getData();
      if (!data) return;
      if (data.generated_at && data.generated_at !== lastDataTs) {
        lastDataTs = data.generated_at;
        renderPinning();
      }
    }, 4000);
  }

  function activatePinningScreen() {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    const screen = document.getElementById("screen-pinning");
    if (screen) screen.classList.add("active");
    document.querySelectorAll(".nav-link").forEach(l => {
      l.classList.toggle("active", l.dataset.route === "/pinning");
    });
    const rail = document.querySelector(".filter-rail");
    if (rail) rail.style.display = "none";
  }

  // ---- Wire it up ------------------------------------------------------
  function init() {
    // Try to register the route into app.js's routes table. If app.js's
    // top-level `routes` const is reachable, this is the cleanest path.
    let registered = false;
    try {
      // eslint-disable-next-line no-undef
      if (typeof routes === "object" && routes !== null) {
        // eslint-disable-next-line no-undef
        routes["/pinning"] = function () {
          activatePinningScreen();
          renderPinning();
          ensureRoutePoll();
        };
        registered = true;
        console.info("[pinning-addon] route /pinning registered into app.js routes");
      }
    } catch (_) {
      // routes not visible — fall through to hashchange handler
    }

    // Always subscribe to hashchange so we render even if the existing
    // router didn't pick up the new route.
    function onHashChange() {
      if (isPinningActive()) {
        if (!registered) activatePinningScreen();
        renderPinning();
        ensureRoutePoll();
      }
    }
    window.addEventListener("hashchange", onHashChange);

    // Fire once at load (in case the URL is already #/pinning)
    if (isPinningActive()) onHashChange();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // app.js loaded first (we're loaded after it via index.html script order)
    init();
  }
})();
