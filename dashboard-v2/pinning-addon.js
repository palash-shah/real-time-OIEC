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
    renderGoodnessOfFit(data.markets);
    if (data.generated_at) lastDataTs = data.generated_at;
  }

  // ---- Goodness-of-fit comparison --------------------------------------
  // The hero block: aggregate "Bridge wins X out of Y" + average advantage %
  function renderGoodnessOfFit(markets) {
    const hero        = document.getElementById("gof-hero");
    const heroLine    = document.getElementById("gof-hero-headline");
    const heroCaption = document.getElementById("gof-hero-caption");
    const grid        = document.getElementById("gof-grid");
    if (!hero || !heroLine || !heroCaption || !grid) return;

    const ms = markets.filter(m => m.gof && m.gof.n_obs > 0);
    if (!ms.length) {
      heroLine.textContent = "—";
      heroCaption.textContent = "Backend hasn't sent goodness-of-fit data yet. Restart the backend after dropping in the new pinning.py and poller.py.";
      grid.innerHTML = "";
      return;
    }

    let bridgeWins = 0, jacobiWins = 0, ties = 0;
    let totalAdvantage = 0, advCount = 0;
    ms.forEach(m => {
      const w = m.gof.winner;
      if (w === "bridge") bridgeWins++;
      else if (w === "jacobi") jacobiWins++;
      else ties++;
      if (typeof m.gof.advantage_pct === "number") {
        totalAdvantage += m.gof.advantage_pct;
        advCount++;
      }
    });
    const meanAdv = advCount > 0 ? (totalAdvantage / advCount) : 0;

    // Hero headline: "Bridge wins 3 of 4" with a colored stripe
    let winnerWord, winnerColor;
    if (bridgeWins > jacobiWins) {
      winnerWord = "Bridge"; winnerColor = COLORS.bridge;
    } else if (jacobiWins > bridgeWins) {
      winnerWord = "Jacobi"; winnerColor = COLORS.jacobi;
    } else {
      winnerWord = "Tied"; winnerColor = COLORS.grey;
    }

    heroLine.innerHTML = `<span style="color:${winnerColor}">${winnerWord}</span> wins <strong>${Math.max(bridgeWins, jacobiWins)} of ${ms.length}</strong> markets`;
    const advWord = meanAdv > 0 ? "lower" : "higher";
    heroCaption.innerHTML = `Mean QLIKE advantage: <strong>${Math.abs(meanAdv).toFixed(1)}%</strong>
      <span style="color:${COLORS.grey}"> · ${meanAdv > 0 ? "bridge has lower loss" : meanAdv < 0 ? "jacobi has lower loss" : "even"}</span>
      <span style="color:${COLORS.grey}"> · scored on ${ms.reduce((s, m) => s + m.gof.n_obs, 0).toLocaleString()} ticks across ${ms.length} markets</span>`;

    // Per-market grid: bars + sparkline
    grid.innerHTML = "";
    markets.forEach((m, i) => {
      const card = document.createElement("div");
      card.className = "gof-card";
      const g = m.gof;
      if (!g || g.n_obs === 0) {
        card.innerHTML = `
          <div class="venue">${m.platform || "—"} · M.0${i + 1}</div>
          <div class="title">${m.name || "(no name)"}</div>
          <div class="pin-empty">Insufficient ticks for goodness-of-fit yet.</div>
        `;
        grid.appendChild(card);
        return;
      }

      // Bar widths — normalize so max QLIKE = 100% width
      const maxLoss = Math.max(g.jacobi_qlike, g.bridge_qlike, 1e-12);
      const jacWidth = (g.jacobi_qlike / maxLoss) * 100;
      const briWidth = (g.bridge_qlike / maxLoss) * 100;

      const winnerLabel = g.winner === "bridge"
        ? `<span class="winner-tag" style="background:${COLORS.bridgeF}; color:${COLORS.bridge}">▲ Bridge</span>`
        : g.winner === "jacobi"
        ? `<span class="winner-tag" style="background:${COLORS.jacobiF}; color:${COLORS.jacobi}">▲ Jacobi</span>`
        : `<span class="winner-tag" style="background:#f4f4f7; color:${COLORS.grey}">≈ Tied</span>`;

      card.innerHTML = `
        <div class="gof-card-head">
          <div>
            <div class="venue">${m.platform || "—"} · M.0${i + 1}</div>
            <div class="title">${m.name || "(no name)"}</div>
          </div>
          ${winnerLabel}
        </div>

        <div class="gof-bars">
          <div class="gof-bar-row">
            <div class="gof-bar-label" style="color:${COLORS.bridge}">Bridge</div>
            <div class="gof-bar-track"><div class="gof-bar-fill" style="width:${briWidth.toFixed(1)}%; background:${COLORS.bridge}"></div></div>
            <div class="gof-bar-val mono">${fmtNum(g.bridge_qlike, 4)}</div>
          </div>
          <div class="gof-bar-row">
            <div class="gof-bar-label" style="color:${COLORS.jacobi}">Jacobi</div>
            <div class="gof-bar-track"><div class="gof-bar-fill" style="width:${jacWidth.toFixed(1)}%; background:${COLORS.jacobi}"></div></div>
            <div class="gof-bar-val mono">${fmtNum(g.jacobi_qlike, 4)}</div>
          </div>
        </div>

        <div class="gof-stats">
          <div class="stat-mini"><div class="k">QLIKE ratio J/B</div><div class="v mono">${fmtNum(g.ratio, 2)}</div></div>
          <div class="stat-mini"><div class="k">Advantage</div><div class="v mono">${typeof g.advantage_pct === "number" ? (g.advantage_pct > 0 ? "+" : "") + g.advantage_pct.toFixed(1) + "%" : "—"}</div></div>
          <div class="stat-mini"><div class="k">Ticks scored</div><div class="v mono">${g.n_obs.toLocaleString()}</div></div>
        </div>

        <div class="gof-spark">
          <canvas id="gof-spark-${i}"></canvas>
        </div>
        <div class="gof-spark-caption">cumulative QLIKE — bridge solid, jacobi dashed — over the buffer's lifetime</div>
      `;
      grid.appendChild(card);
    });

    // Draw the sparkline charts
    markets.forEach((m, i) => {
      const g = m.gof;
      if (!g || !g.spark_t || !g.spark_t.length) return;
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
