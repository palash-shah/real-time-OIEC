/* =====================================================================
   OIEC Console v2 · app.js
   - 3-tier data loader (window.OIEC_DATA → fetch → embedded)
   - Jacobi-Bachelier pricing engine (JS port of generate_data.py)
   - Hash router over 5 screens
   - 4 interactive views: Markets, Surface Lab, BVIX, Arbitrage
   ===================================================================== */

"use strict";

/* ---------- formatting helpers ---------- */
const fmt = {
  pctRaw: (v, d = 1) => (v * 100).toFixed(d),
  num:    (v, d = 3) => Number(v).toFixed(d),
  cents:  (v, d = 2) => Number(v).toFixed(d) + "¢",
  x:      (v, d = 1) => Number(v).toFixed(d) + "×",
  years:  (y) => {
    if (y >= 1) return y.toFixed(2) + "y";
    const days = Math.round(y * 365);
    if (days > 60) return (days / 30).toFixed(1) + "mo";
    return days + "d";
  },
  date:   (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  dateLong: (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
  time:   (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
  money:  (v) => "$" + Math.round(v).toLocaleString("en-US"),
  pctSign:(v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%",
};

/* =====================================================================
   Jacobi-Bachelier pricing engine — JS port of generate_data.py
   ===================================================================== */
const engine = (() => {
  const SQRT_2PI = Math.sqrt(2 * Math.PI);
  function normPdf(x) { return Math.exp(-0.5 * x * x) / SQRT_2PI; }
  function normCdf(x) {
    // Abramowitz-Stegun approximation, accurate to ~7 digits
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return 0.5 * (1.0 + sign * y);
  }

  function call(P, K, sigma, tau) {
    const variance = Math.max(P * (1 - P), 1e-6);
    const sd = sigma * Math.sqrt(variance) * Math.sqrt(Math.max(tau, 1e-6));
    if (sd < 1e-8) return Math.max(P - K, 0);
    const d = (P - K) / sd;
    const pdf = normPdf(d), cdf = normCdf(d);
    return Math.max((P - K) * cdf + sd * pdf, 0);
  }

  function put(P, K, sigma, tau) {
    // put-call parity on event future: C - P_opt = P - K
    const c = call(P, K, sigma, tau);
    return Math.max(c - (P - K), 0);
  }

  function greeks(P, K, sigma, tau) {
    const variance = Math.max(P * (1 - P), 1e-6);
    const sd = sigma * Math.sqrt(variance) * Math.sqrt(Math.max(tau, 1e-6));
    if (sd < 1e-8) return { deltaC: 0, deltaP: 0, gamma: 0, vega: 0, theta: 0 };
    const d = (P - K) / sd;
    const pdf = normPdf(d), cdf = normCdf(d);
    return {
      deltaC: cdf,
      deltaP: cdf - 1,
      gamma:  pdf / sd,
      vega:   pdf * Math.sqrt(variance) * Math.sqrt(Math.max(tau, 1e-6)),
      theta: -0.5 * sigma * Math.sqrt(variance) * pdf / Math.sqrt(Math.max(tau, 1e-6)),
    };
  }

  return { call, put, greeks };
})();

/* =====================================================================
   Data loader — four tiers
   ===================================================================== */
let DATA = null;
let SRC  = null;

/** Return the configured backend URL (no trailing slash), or "" if same-origin. */
function backendUrl() {
  const u = (window.OIEC_CONFIG && window.OIEC_CONFIG.backend_url) || "";
  return u.replace(/\/+$/, "");
}

/** Build a URL relative to the configured backend (or same-origin if blank). */
function backendURL(path) {
  const base = backendUrl();
  if (base) return base + path;
  return path;
}

async function loadData() {
  // Skip data.js fallback — user explicitly wants to see errors rather than
  // render stale embedded numbers. The old data.js was showing synthetic-seed
  // prices that drifted to unrealistic values and confused everything.

  // 1. Fetch from backend (cross-origin via CORS when Pages → Render)
  const base = backendUrl();
  if (base || location.protocol !== "file:") {
    try {
      const res = await fetch(backendURL("/data.json"), { cache: "no-store" });
      if (res.ok) {
        DATA = await res.json();
        SRC = base ? "backend" : "data.json";
        return;
      }
    } catch (err) {
      console.warn("[OIEC] backend fetch failed:", err);
    }
  }

  // 2. Only as an absolute last resort (e.g. serving dashboard from file://
  //    without a backend), use the inline embed.
  const embed = document.getElementById("oiec-embed");
  if (embed) {
    try {
      const parsed = JSON.parse(embed.textContent);
      if (parsed && parsed.markets && parsed.markets.length) {
        DATA = parsed;
        SRC = "embedded";
        console.warn("[OIEC] using embedded fallback data; start the backend for live prices");
        return;
      }
    } catch (_) {}
  }

  throw new Error(
    "Can't reach the backend.\n\n" +
    "If you're on GitHub Pages, check that dashboard-v2/config.js points at\n" +
    "your Render service URL. Then hard-reload (Cmd+Shift+R) to bust the cache."
  );
}

/* =====================================================================
   Chart defaults (Chart.js)
   ===================================================================== */
function applyChartDefaults() {
  if (!window.Chart) return;
  const C = Chart.defaults;
  C.font.family = '"Instrument Sans", ui-sans-serif, system-ui, sans-serif';
  C.font.size = 11.5;
  C.color = "#6e6e73";
  C.borderColor = "#e5e5ea";
  C.scale.grid.color = "#eeeef2";
  C.scale.grid.tickColor = "#e5e5ea";
  C.scale.ticks.color = "#6e6e73";
  C.scale.ticks.font = { family: '"JetBrains Mono", monospace', size: 10.5 };
  C.plugins.legend.labels.color = "#3a3a3c";
  C.plugins.legend.labels.boxWidth = 10;
  C.plugins.legend.labels.boxHeight = 10;
  C.plugins.legend.labels.font = { family: '"Instrument Sans"', size: 12 };
  C.plugins.tooltip.backgroundColor = "#1d1d1f";
  C.plugins.tooltip.borderColor = "#1d1d1f";
  C.plugins.tooltip.titleColor = "#ffffff";
  C.plugins.tooltip.bodyColor = "#e5e5ea";
  C.plugins.tooltip.titleFont = { family: '"JetBrains Mono"', size: 11, weight: "500" };
  C.plugins.tooltip.bodyFont  = { family: '"JetBrains Mono"', size: 11 };
  C.plugins.tooltip.padding = 10;
  C.plugins.tooltip.cornerRadius = 8;
  C.plugins.tooltip.displayColors = false;
  C.elements.point.radius = 0;
  C.elements.point.hoverRadius = 4;
  C.elements.line.borderWidth = 1.8;
  C.elements.line.tension = 0.28;
}

/* palette — single source of truth for chart colors */
const C = {
  call:  "#1a56db",
  callF: "rgba(26, 86, 219, 0.10)",
  put:   "#b45309",
  putF:  "rgba(180, 83, 9, 0.09)",
  mb:    "#0891b2",
  mbF:   "rgba(8, 145, 178, 0.10)",
  mf:    "#b45309",
  ink:   "#1d1d1f",
  fill:  "rgba(26, 86, 219, 0.08)",
};

/* =====================================================================
   Router
   ===================================================================== */
const routes = {
  "/":        renderHome,
  "/markets": renderMarkets,
  "/surface": renderSurface,
  "/bvix":    renderBVIX,
  "/arb":     renderArb,
};

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const path = routes[hash] ? hash : "/";
  // screen swap
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const screenId = "screen-" + (path === "/" ? "home" : path.slice(1));
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add("active");
  // nav active
  document.querySelectorAll(".nav-link").forEach(l => {
    l.classList.toggle("active", l.dataset.route === path);
  });
  // re-render current view (safe: all renderers are idempotent)
  routes[path]();
  if (window.updateFilterRailVisibility) window.updateFilterRailVisibility(path);
  window.scrollTo({ top: 0, behavior: "auto" });
}

window.addEventListener("hashchange", route);

/* =====================================================================
   HOME screen
   ===================================================================== */
function renderHome() {
  const avgCompression =
    DATA.markets.reduce((s, m) => s + m.arbitrage.compression_factor, 0) / DATA.markets.length;
  const el = document.getElementById("home-bignum");
  el.innerHTML = avgCompression.toFixed(0) + '<span class="suffix">×</span>';

  // Stats strip — pulls live aggregates from DATA
  const avgBvix  = DATA.markets.reduce((s, m) => s + m.bvix_model_free, 0) / DATA.markets.length;
  const avgSigma = DATA.markets.reduce((s, m) => s + m.sigma_hat, 0) / DATA.markets.length;
  const avgTau   = DATA.markets.reduce((s, m) => s + m.tau, 0) / DATA.markets.length;
  // "Ticks served" — prefer the backend's monotonic counter if present; it
  // increments on every successful price push across all markets since the
  // poller started. The old history_prices.length fallback caps at
  // HISTORY_POINTS × markets, so this is the genuinely monotonic version.
  const metaQuotes = DATA._meta && DATA._meta.quotes_served;
  const totalTicks = (typeof metaQuotes === "number")
    ? metaQuotes
    : DATA.markets.reduce((s, m) => s + (m.history_prices?.length || 0), 0);

  const setStat = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
  };
  setStat("stat-markets", DATA.markets.length);
  setStat("stat-bvix",    avgBvix.toFixed(3));
  setStat("stat-sigma",   avgSigma.toFixed(3));
  setStat("stat-tau",     avgTau.toFixed(2) + '<small>y</small>');
  // Rough "ticks served" — history points summed. Displays with k/M suffix
  // so 2,400 reads as "2.4k" rather than a bare number.
  const fmtTicks = (n) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + '<small>M</small>';
    if (n >= 1_000)     return (n / 1_000).toFixed(1)     + '<small>k</small>';
    return String(n);
  };
  setStat("stat-ticks",   fmtTicks(totalTicks));
  setStat("research-compression", avgCompression.toFixed(0));

  // Update the spotlight section header with the live market count (word form
  // reads more naturally than a digit for counts < 20)
  const countEl = document.getElementById("spotlight-count");
  if (countEl) {
    const n = DATA.markets.length;
    const words = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve"];
    countEl.textContent = words[n] ? words[n].charAt(0).toUpperCase() + words[n].slice(1) : String(n);
  }

  const grid = document.getElementById("spotlight-grid");
  grid.innerHTML = "";
  DATA.markets.forEach((m, i) => {
    const el = document.createElement("div");
    el.className = "spotlight-card";
    el.innerHTML = `
      <div class="venue">${m.platform} · M.0${i + 1}</div>
      <div class="title">${m.name}</div>
      <div class="bvix-mini">
        <span><span class="k">σ̂</span> <span class="v">${fmt.num(m.sigma_hat, 3)}</span></span>
        <span><span class="k">BVIX</span> <span class="v">${fmt.num(m.bvix_model_free, 3)}</span></span>
        <span><span class="k">τ</span> <span class="v">${fmt.num(m.tau, 2)}y</span></span>
      </div>
      <div class="prob-row">
        <div>
          <div class="prob">${fmt.pctRaw(m.current_price, 1)}<span class="unit">¢</span></div>
          <div class="chance">${(m.current_price * 100).toFixed(0)}% chance</div>
        </div>
      </div>
      <div class="yes-no">
        <button class="yn-btn yes">Buy Yes · ${fmt.pctRaw(m.current_price, 0)}¢</button>
        <button class="yn-btn no">Buy No · ${fmt.pctRaw(1 - m.current_price, 0)}¢</button>
      </div>
    `;
    el.addEventListener("click", (ev) => {
      // Don't hijack clicks on Yes/No buttons (they'd otherwise jump to markets too)
      if (ev.target.closest(".yn-btn")) return;
      sessionStorage.setItem("oiec:selectedMarket", String(i));
      location.hash = "#/markets";
    });
    grid.appendChild(el);
  });
}

/* Inline SVG sparkline — keeps the home page crisp without chart.js weight */
function renderSparkline(values, w, h) {
  if (!values.length) return "";
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h * 0.9 - h * 0.05;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${C.call}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* =====================================================================
   MARKETS screen
   ===================================================================== */
const marketCharts = { surface: null, history: null, bvix: null };

function renderMarkets() {
  const grid = document.getElementById("markets-grid");
  grid.innerHTML = "";
  DATA.markets.forEach((m, i) => {
    const el = document.createElement("div");
    el.className = "market-card";
    el.innerHTML = `
      <div class="venue">${m.platform} · M.0${i + 1}</div>
      <div class="title">${m.name}</div>
      <div class="price mono">${fmt.pctRaw(m.current_price, 1)}<span class="unit">¢</span></div>
      <div class="stats">
        <div class="stat"><div class="k">σ̂</div><div class="v">${fmt.num(m.sigma_hat, 3)}</div></div>
        <div class="stat"><div class="k">BVIX</div><div class="v">${fmt.num(m.bvix_model_free, 3)}</div></div>
        <div class="stat"><div class="k">τ</div><div class="v">${fmt.num(m.tau, 2)}</div></div>
        <div class="stat"><div class="k">TTR</div><div class="v">${fmt.years(m.time_to_resolution_years)}</div></div>
      </div>
    `;
    el.addEventListener("click", () => openMarketDetail(i));
    grid.appendChild(el);
  });

  const prefer = sessionStorage.getItem("oiec:selectedMarket");
  if (prefer !== null) {
    sessionStorage.removeItem("oiec:selectedMarket");
    openMarketDetail(+prefer);
  }

  document.getElementById("d-close").onclick = () => {
    document.getElementById("market-detail").classList.remove("open");
  };
}

function openMarketDetail(i) {
  const m = DATA.markets[i];
  document.getElementById("market-detail").classList.add("open");
  document.getElementById("d-title").textContent = m.name;
  document.getElementById("d-price").innerHTML = `${fmt.pctRaw(m.current_price, 1)}<small>¢</small>`;
  document.getElementById("d-sigma").textContent = fmt.num(m.sigma_hat, 3);
  document.getElementById("d-bvix-mf").textContent = fmt.num(m.bvix_model_free, 3);
  document.getElementById("d-bvix-mb").textContent = fmt.num(m.bvix_model_based, 3);
  document.getElementById("d-varswap").textContent = fmt.num(m.variance_swap_strike, 4);
  document.getElementById("d-surf-sub").textContent = `${m.strikes.length} strikes · τ = ${m.tau}`;

  drawSurfaceChart(m);
  drawGreeksTable(m);
  drawHistoryChart(m);
  drawBVIXChart(m);

  document.getElementById("market-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function destroy(c) { if (c) c.destroy(); }

function drawSurfaceChart(m) {
  if (!window.Chart) return;
  const labels = m.strikes.map(s => s.toFixed(2));

  // If we already have a chart of this shape, just swap the data in place.
  // This gives smooth animated transitions from one tick to the next
  // rather than the destroy-and-rebuild flash.
  if (marketCharts.surface && marketCharts.surface._oiecMarketIdx === DATA.markets.indexOf(m)) {
    const c = marketCharts.surface;
    c.data.labels = labels;
    c.data.datasets[0].data = m.call_prices;
    c.data.datasets[1].data = m.put_prices;
    // update ATM marker position
    c.options.plugins.annotation = buildSurfaceAnnotations(m);
    c.update("active");
    return;
  }

  // Fresh build (different market or first draw)
  destroy(marketCharts.surface);
  const ctx = document.getElementById("d-chart-surface");
  marketCharts.surface = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Call", data: m.call_prices, borderColor: C.call,
          backgroundColor: C.callF, fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 },
        { label: "Put",  data: m.put_prices,  borderColor: C.put,
          backgroundColor: C.putF,  fill: true, pointRadius: 0, borderWidth: 2, borderDash: [5, 3], tension: 0.15 },
      ],
    },
    options: {
      maintainAspectRatio: false, responsive: true,
      interaction: { mode: "index", intersect: false },
      animation: { duration: 400, easing: "easeOutQuart" },
      plugins: {
        legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line" } },
        tooltip: {
          callbacks: {
            title: items => `K = ${items[0].label}   (spot ${(m.current_price * 100).toFixed(1)}¢)`,
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(4)}`,
          },
        },
        annotation: buildSurfaceAnnotations(m),
      },
      scales: {
        x: { title: { display: true, text: "strike K", color: "#a1a1a6", font: { size: 10 } } },
        y: { title: { display: true, text: "premium",  color: "#a1a1a6", font: { size: 10 } },
             ticks: { callback: v => v.toFixed(2) } },
      },
    },
  });
  marketCharts.surface._oiecMarketIdx = DATA.markets.indexOf(m);
}

/** Annotations for the option surface: vertical line at spot price */
function buildSurfaceAnnotations(m) {
  // Find the nearest strike to spot for x-axis positioning (category scale)
  const atmIdx = m.strikes.reduce(
    (best, s, i) => Math.abs(s - m.current_price) < Math.abs(m.strikes[best] - m.current_price) ? i : best, 0
  );
  // Chart.js annotation plugin may not be loaded — this object is harmless if ignored
  return {
    annotations: {
      atmLine: {
        type: "line",
        xMin: atmIdx, xMax: atmIdx,
        borderColor: "#1a56db",
        borderWidth: 1, borderDash: [4, 4],
        label: { display: true, content: "spot", position: "end",
                 backgroundColor: "rgba(26,86,219,0.92)", color: "#fff", padding: 3, font: { size: 9 } },
      },
    },
  };
}

function drawGreeksTable(m) {
  const tbl = document.getElementById("d-greeks");
  const atmIdx = m.strikes.reduce(
    (best, s, i) => Math.abs(s - m.current_price) < Math.abs(m.strikes[best] - m.current_price) ? i : best, 0
  );
  const want = [atmIdx - 4, atmIdx - 2, atmIdx, atmIdx + 2, atmIdx + 4];
  const pick = want.filter(j => j >= 0 && j < m.strikes.length);

  let html = `<tr>
    <th data-explain="variance-swap-k">K</th>
    <th data-explain="delta-c">δc</th>
    <th data-explain="delta-p">δp</th>
    <th data-explain="gamma">γ</th>
    <th data-explain="vega">ν</th>
    <th data-explain="theta">θ</th>
  </tr>`;
  pick.forEach(j => {
    const isAtm = j === atmIdx;
    html += `<tr class="${isAtm ? 'atm' : ''}">
      <td>${m.strikes[j].toFixed(2)}${isAtm ? ' · ATM' : ''}</td>
      <td>${m.delta_c[j].toFixed(3)}</td>
      <td>${m.delta_p[j].toFixed(3)}</td>
      <td>${m.gamma[j].toFixed(3)}</td>
      <td>${m.vega[j].toFixed(3)}</td>
      <td>${m.theta[j].toFixed(3)}</td>
    </tr>`;
  });
  tbl.innerHTML = html;
}

/* =====================================================================
   Markets detail — history chart (lightweight-charts)

   State lives in historyChartState so we can do incremental updates
   on each WS tick rather than rebuilding the chart.
   ===================================================================== */
const historyChartState = {
  marketIdx:       -1,
  kind:            "area",     // "area" or "candle"
  timeframeSec:    15,         // default 15s candles
  chart:           null,
  series:          null,
  lastTs:          0,
  pendingCandle:   null,
  prevClose:       null,
  rawPoints:       [],
};

const TIMEFRAMES = [
  { key: "1s",  sec: 1,     label: "1s",  precision: 3, minMove: 0.0001 },
  { key: "15s", sec: 15,    label: "15s", precision: 3, minMove: 0.0005 },
  { key: "1m",  sec: 60,    label: "1m",  precision: 2, minMove: 0.001  },
  { key: "5m",  sec: 300,   label: "5m",  precision: 2, minMove: 0.001  },
  { key: "30m", sec: 1800,  label: "30m", precision: 2, minMove: 0.001  },
  { key: "1h",  sec: 3600,  label: "1h",  precision: 1, minMove: 0.001  },
  { key: "1d",  sec: 86400, label: "1d",  precision: 1, minMove: 0.001  },
];

function currentTimeframe() {
  return TIMEFRAMES.find(t => t.sec === historyChartState.timeframeSec) || TIMEFRAMES[1];
}

/* Chart color palette — Bloomberg-aesthetic tuned for Apple off-white bg */
const LWC_COLORS = {
  up:        "#047857",   // green — close > prevClose
  down:      "#b91c1c",   // red — close < prevClose
  flat:      "#a1a1a6",   // grey — unchanged
  line:      "#1a56db",   // editorial blue
  lineSoft:  "rgba(26, 86, 219, 0.22)",
  sigma:     "#7c3aed",   // violet
  bvix:      "#c2410c",   // burnt orange
  grid:      "#eeeef2",
  text:      "#6e6e73",
};

function mountHistoryChart(containerId) {
  if (!window.LightweightCharts) return null;
  const el = document.getElementById(containerId);
  // Always empty first — safe because drawHistoryChart has a fast-path
  // that skips this function entirely for same-market updates.
  el.innerHTML = "";
  const chart = LightweightCharts.createChart(el, {
    width:  el.clientWidth,
    height: el.clientHeight || 300,
    layout: { background: { color: "transparent" }, textColor: LWC_COLORS.text,
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5,
              attributionLogo: false },
    grid:   { vertLines: { color: LWC_COLORS.grid, style: 1 },
              horzLines: { color: LWC_COLORS.grid, style: 1 } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.10, bottom: 0.18 }},
    // Single-axis chart — no left scale, no overlays. The crosshair readout
    // panel displays σ̂ and BVIX from the backend data, not from a chart line.
    leftPriceScale:  { visible: false },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      barSpacing: 6,
      minBarSpacing: 2,
      shiftVisibleRangeOnNewBar: true,
      rightBarStaysOnScroll: true,
      fixLeftEdge: true,
      fixRightEdge: false,
      lockVisibleTimeRangeOnResize: true,
    },
    crosshair: {
      mode: 1,
      vertLine: { color: "#c7c7cc", width: 1, style: 3, labelBackgroundColor: LWC_COLORS.line },
      horzLine: { color: "#c7c7cc", width: 1, style: 3, labelBackgroundColor: LWC_COLORS.line },
    },
    handleScale:  { axisPressedMouseMove: { time: true, price: false },
                    mouseWheel: true, pinch: true },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  });

  const ro = new ResizeObserver(() => {
    if (el.clientWidth && el.clientHeight) chart.resize(el.clientWidth, el.clientHeight);
  });
  ro.observe(el);

  return chart;
}

/**
 * After seeding data, pin the visible time range to the actual data span,
 * and subscribe to range-change events so we can clamp the user's manual
 * zooms. This fixes: when the user zooms out past the data span,
 * lightweight-charts renders blank regions with axis labels drifting into
 * "1970" territory. We prevent that by clamping.
 */
function constrainTimeScale(raw) {
  if (!historyChartState.chart || !raw.length) return;
  const tFirst = raw[0].time;
  const tLast  = raw[raw.length - 1].time;
  const ts = historyChartState.chart.timeScale();

  // Show from the first real point to "now" with a small right pad
  ts.setVisibleRange({ from: tFirst, to: tLast + 30 });

  // Guard: when user zooms, snap range back into the allowed window
  ts.subscribeVisibleTimeRangeChange((r) => {
    if (!r) return;
    // If the requested range falls outside the data span by more than
    // ~2x the data width, clamp it. We allow a little extra breathing
    // room on the right (future) but never on the left (past 1970).
    const span = Math.max(60, tLast - tFirst);
    const minFrom = tFirst - span * 0.1;
    const maxTo   = tLast + span * 2.0;
    let from = r.from, to = r.to;
    let clamped = false;
    if (from < minFrom) { from = minFrom; clamped = true; }
    if (to   > maxTo)   { to   = maxTo;   clamped = true; }
    // Also prevent zooming in so far that we only see < 2 bars
    if ((to - from) < 20) { from = r.from; to = from + 20; clamped = true; }
    if (clamped) {
      // Important: defer to next microtask to avoid recursion
      Promise.resolve().then(() => {
        try { ts.setVisibleRange({ from, to }); } catch (_) {}
      });
    }
  });
}

/**
 * Render the price-history panel for market m.
 * Idempotent: if the chart already exists for this market, delegates to
 * the incremental update path — never tears down the DOM.
 */
function drawHistoryChart(m) {
  if (!window.LightweightCharts) {
    console.warn("[OIEC] lightweight-charts not loaded");
    return;
  }

  const idx = DATA.markets.indexOf(m);

  // Fast path: chart exists for this market → just update, no rebuild
  if (historyChartState.chart && historyChartState.marketIdx === idx && historyChartState.series) {
    updateHistoryChartIncremental(m);
    return;
  }

  const raw = m.history_timestamps.map((iso, k) => ({
    time:  Math.floor(new Date(iso).getTime() / 1000),
    value: m.history_prices[k],
  }));
  historyChartState.rawPoints = raw;

  // Slow path: market changed or first draw. Teardown + rebuild.
  if (historyChartState.chart) {
    historyChartState.chart.remove();
    historyChartState.chart = null;
    historyChartState.series = null;
  }
  historyChartState.chart = mountHistoryChart("d-chart-history");
  historyChartState.marketIdx = idx;
  historyChartState.lastTs = 0;
  historyChartState.pendingCandle = null;
  historyChartState.prevClose = null;
  attachHistorySeries(historyChartState.kind);
  attachCrosshairReadout();

  seedHistorySeries(raw);
  constrainTimeScale(raw);

  document.querySelectorAll('.chart-toggle[data-target="d-chart-history"] button')
    .forEach(btn => btn.classList.toggle("active", btn.dataset.kind === historyChartState.kind));
  updateTimeframeButtons();
}

function attachHistorySeries(kind) {
  if (!historyChartState.chart) return;
  if (historyChartState.series) {
    historyChartState.chart.removeSeries(historyChartState.series);
    historyChartState.series = null;
  }

  const tf = currentTimeframe();
  const fmtCents = v => (v * 100).toFixed(tf.precision) + "¢";

  if (kind === "candle") {
    historyChartState.series = historyChartState.chart.addCandlestickSeries({
      upColor:       LWC_COLORS.up,
      downColor:     LWC_COLORS.down,
      wickUpColor:   LWC_COLORS.up,
      wickDownColor: LWC_COLORS.down,
      borderVisible: false,
      priceScaleId:  "right",
      priceFormat: { type: "custom", minMove: tf.minMove, formatter: fmtCents },
    });
  } else {
    historyChartState.series = historyChartState.chart.addAreaSeries({
      lineColor:   LWC_COLORS.line,
      topColor:    LWC_COLORS.lineSoft,
      bottomColor: "rgba(26, 86, 219, 0.00)",
      lineWidth: 2,
      priceScaleId:  "right",
      priceFormat: { type: "custom", minMove: tf.minMove, formatter: fmtCents },
    });
  }

  // Auto-scale price axis — crucial for short timeframes where prices barely
  // move. Without this, a 1s chart would show a flat line squished at the top
  // of a 0..100¢ scale. With it, y-axis auto-fits to the data range.
  historyChartState.chart.priceScale("right").applyOptions({
    autoScale: true,
    mode: 0,   // Normal mode (not percentage)
  });

  historyChartState.kind = kind;
}

function seedHistorySeries(raw) {
  if (!historyChartState.series || !raw.length) return;

  const bucketSec = historyChartState.timeframeSec;

  if (historyChartState.kind === "candle") {
    const candles = bucketIntoCandles(raw, bucketSec);
    let prevClose = candles[0] ? candles[0].open : 0;
    for (const c of candles) {
      const up = c.close > prevClose + 1e-9;
      const down = c.close < prevClose - 1e-9;
      c.color       = up ? LWC_COLORS.up : down ? LWC_COLORS.down : LWC_COLORS.flat;
      c.wickColor   = c.color;
      c.borderColor = c.color;
      prevClose = c.close;
    }
    historyChartState.series.setData(candles);
    historyChartState.pendingCandle = candles.length ? { ...candles[candles.length - 1] } : null;
    historyChartState.prevClose = prevClose;
  } else {
    // Line mode: bucket by close-of-bucket so the line has a consistent
    // timeframe granularity. Without this, a 1m-timeframe line chart would
    // have ~60 redundant points per minute when data is at 1Hz.
    const lineData = bucketIntoCloses(raw, bucketSec);
    historyChartState.series.setData(lineData);
  }

  historyChartState.lastTs = raw[raw.length - 1].time;
}

/** For line mode: collapse each bucket to its close value (last observation). */
function bucketIntoCloses(raw, bucketSec) {
  const out = [];
  let curBucket = null, curValue = null;
  for (const p of raw) {
    const b = Math.floor(p.time / bucketSec) * bucketSec;
    if (b !== curBucket) {
      if (curBucket !== null) out.push({ time: curBucket, value: curValue });
      curBucket = b;
    }
    curValue = p.value;
  }
  if (curBucket !== null) out.push({ time: curBucket, value: curValue });
  return out;
}

function updateHistoryChartIncremental(m) {
  const idx = DATA.markets.indexOf(m);
  if (idx !== historyChartState.marketIdx) {
    drawHistoryChart(m);
    return;
  }
  if (!historyChartState.series) return;

  const raw = m.history_timestamps.map((iso, k) => ({
    time:  Math.floor(new Date(iso).getTime() / 1000),
    value: m.history_prices[k],
  }));
  historyChartState.rawPoints = raw;

  const newPts = raw.filter(p => p.time > historyChartState.lastTs);
  if (!newPts.length) return;

  if (historyChartState.kind === "candle") {
    newPts.forEach(p => pushCandleTick(p));
  } else {
    // Line mode: bucket the new ticks into the active timeframe and push
    // close-of-bucket. lightweight-charts' update() handles both new-bucket
    // ("insert") and same-bucket ("amend last point") cases automatically.
    const tfSec = historyChartState.timeframeSec;
    newPts.forEach(p => {
      const b = Math.floor(p.time / tfSec) * tfSec;
      historyChartState.series.update({ time: b, value: p.value });
    });
  }

  historyChartState.lastTs = newPts[newPts.length - 1].time;
}

function bucketIntoCandles(raw, bucketSec) {
  const out = [];
  let cur = null;
  for (const p of raw) {
    const bucket = Math.floor(p.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur);
      cur = { time: bucket, open: p.value, high: p.value, low: p.value, close: p.value };
    } else {
      cur.high  = Math.max(cur.high, p.value);
      cur.low   = Math.min(cur.low,  p.value);
      cur.close = p.value;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function pushCandleTick(pt) {
  const tfSec = historyChartState.timeframeSec;
  const bucket = Math.floor(pt.time / tfSec) * tfSec;
  const cur = historyChartState.pendingCandle;
  if (!cur || cur.time !== bucket) {
    if (cur) historyChartState.prevClose = cur.close;
    const prev = historyChartState.prevClose ?? pt.value;
    const up   = pt.value > prev + 1e-9;
    const down = pt.value < prev - 1e-9;
    const color = up ? LWC_COLORS.up : down ? LWC_COLORS.down : LWC_COLORS.flat;
    historyChartState.pendingCandle = {
      time:  bucket,
      open:  pt.value, high: pt.value, low: pt.value, close: pt.value,
      color, wickColor: color, borderColor: color,
    };
  } else {
    cur.high  = Math.max(cur.high, pt.value);
    cur.low   = Math.min(cur.low,  pt.value);
    cur.close = pt.value;
    const prev = historyChartState.prevClose ?? cur.open;
    const up   = cur.close > prev + 1e-9;
    const down = cur.close < prev - 1e-9;
    const color = up ? LWC_COLORS.up : down ? LWC_COLORS.down : LWC_COLORS.flat;
    cur.color = cur.wickColor = cur.borderColor = color;
  }
  historyChartState.series.update(historyChartState.pendingCandle);
}

/* -- Crosshair readout: shows P, σ̂, BVIX at the hovered time -- */
function attachCrosshairReadout() {
  if (!historyChartState.chart) return;
  let readout = document.getElementById("history-crosshair-readout");
  if (!readout) {
    readout = document.createElement("div");
    readout.id = "history-crosshair-readout";
    readout.className = "crosshair-readout";
    const container = document.getElementById("d-chart-history");
    if (container) container.parentNode.insertBefore(readout, container);
  }
  historyChartState.chart.subscribeCrosshairMove((param) => {
    if (!param || !param.time || !param.seriesData || param.seriesData.size === 0) {
      // No hover — show the latest point in "LIVE" mode
      const last = historyChartState.rawPoints[historyChartState.rawPoints.length - 1];
      if (!last) return;
      readout.innerHTML = formatReadout(last.time, last.value, "now");
      return;
    }
    // Hover mode — pull the value at this time from the price series
    let priceVal = null;
    param.seriesData.forEach((v, series) => {
      if (series === historyChartState.series) {
        priceVal = v.value ?? v.close;
      }
    });
    if (priceVal === null) return;
    readout.innerHTML = formatReadout(param.time, priceVal, "hover");
  });
}

function formatReadout(time, price, mode) {
  const d = new Date(time * 1000);
  const tag = mode === "now" ? "LIVE" : "at";
  const m = DATA.markets[historyChartState.marketIdx];
  if (!m) {
    return `<div class="cr-tag">${tag}</div><div class="cr-time">—</div>
            <span class="cr-kv"><span class="k">P</span><span class="v">${(price * 100).toFixed(2)}¢</span></span>`;
  }
  // σ̂ and BVIX come from the backend's calibrated values — not computed per-point.
  // These are the "current" regime values; historical σ̂/BVIX aren't in the payload
  // (would require backend-side storage which we deliberately keep stateless for now).
  const sigma = m.sigma_hat;
  const bvix  = m.bvix_model_free;
  return `
    <div class="cr-tag">${tag}</div>
    <div class="cr-time">${d.toUTCString().slice(5, 22)} UTC</div>
    <span class="cr-kv"><span class="k">P</span><span class="v">${(price * 100).toFixed(2)}¢</span></span>
    <span class="cr-kv"><span class="k">σ̂</span><span class="v">${sigma.toFixed(3)}</span></span>
    <span class="cr-kv"><span class="k">BVIX</span><span class="v">${bvix.toFixed(3)}</span></span>
  `;
}

/* Wire up the Line/Candle toggle — delegated via document */
(function initHistoryToggle() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(
      '.chart-toggle[data-target="d-chart-history"] button'
    );
    if (!btn) return;
    const kind = btn.dataset.kind;
    if (kind === historyChartState.kind) return;
    historyChartState.kind = kind;
    attachHistorySeries(kind);
    seedHistorySeries(historyChartState.rawPoints);
    document.querySelectorAll('.chart-toggle[data-target="d-chart-history"] button')
      .forEach(b => b.classList.toggle("active", b.dataset.kind === kind));
  });
})();

/* Timeframe selector — rebucket raw points into the selected interval */
(function initTimeframeToggle() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#history-tf-toggle button");
    if (!btn) return;
    const tf = parseInt(btn.dataset.tf, 10);
    if (!tf || tf === historyChartState.timeframeSec) return;
    historyChartState.timeframeSec = tf;
    // Re-attach the series (picks up new precision) and re-seed from raw data
    if (historyChartState.chart) {
      historyChartState.pendingCandle = null;
      historyChartState.prevClose = null;
      attachHistorySeries(historyChartState.kind);
      seedHistorySeries(historyChartState.rawPoints);
      // Let lightweight-charts auto-scale the time axis to fit the new granularity
      historyChartState.chart.timeScale().fitContent();
    }
    updateTimeframeButtons();
  });
})();

function updateTimeframeButtons() {
  document.querySelectorAll("#history-tf-toggle button")
    .forEach(b => b.classList.toggle("active", parseInt(b.dataset.tf, 10) === historyChartState.timeframeSec));
}

/* Filter rail — tags on the card DOM are used for client-side filtering.
   Each market card gets a data-tags attribute based on its metadata
   (keyword matching on the title and platform). Clicking a pill hides
   any card whose tags don't include the pill's filter key. */
(function initFilterRail() {
  function tagsFor(m) {
    const t = (m.name || "").toLowerCase();
    const venue = (m.platform || "").toLowerCase();
    const tags = ["all", venue];
    if (/election|president|democrat|republican|senate|congress|party|vance|newsom/i.test(t)) tags.push("politics");
    if (/fed|fomc|rate|cpi|inflation|unemployment/i.test(t)) tags.push("fed");
    if (/nominee|primary|caucus/i.test(t)) tags.push("primary");
    return tags;
  }

  function applyFilter(key) {
    // Home spotlights and Markets grid both use cards indexed by DATA.markets order
    document.querySelectorAll(".spotlight-card, .market-card").forEach((card, i) => {
      const marketIdx = i % DATA.markets.length; // same index across both grids
      const m = DATA.markets[marketIdx];
      if (!m) return;
      const tags = tagsFor(m);
      const show = key === "all" || tags.includes(key);
      card.style.display = show ? "" : "none";
    });
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#filter-rail button[data-filter]");
    if (!btn) return;
    document.querySelectorAll("#filter-rail button").forEach(b =>
      b.classList.toggle("active", b === btn));
    applyFilter(btn.dataset.filter);
  });

  // Hide the rail on screens where it doesn't make sense (Surface Lab, Arb,
  // market detail). Only show on Home and Markets.
  window.updateFilterRailVisibility = function(route) {
    const rail = document.querySelector(".filter-rail");
    if (!rail) return;
    rail.style.display = (route === "/" || route === "/markets") ? "" : "none";
  };
})();


function drawBVIXChart(m) {
  if (!window.Chart) return;
  const tMax = Math.min(m.time_to_resolution_years, 1.0);
  const horizons = [];
  for (let i = 1; i <= 20; i++) horizons.push(tMax * (i / 20));
  const labels = horizons.map(t => fmt.years(t));

  const baseMB = m.bvix_model_based / (m.sigma_hat * Math.sqrt(m.tau));
  const baseMF = m.bvix_model_free  / (m.sigma_hat * Math.sqrt(m.tau));
  const mb = horizons.map(t => m.sigma_hat * Math.sqrt(t) * baseMB);
  const mf = horizons.map(t => m.sigma_hat * Math.sqrt(t) * baseMF);

  // Smooth in-place update if chart already exists for this market
  if (marketCharts.bvix && marketCharts.bvix._oiecMarketIdx === DATA.markets.indexOf(m)) {
    const c = marketCharts.bvix;
    c.data.labels = labels;
    c.data.datasets[0].data = mb;
    c.data.datasets[1].data = mf;
    c.update("active");
    return;
  }

  destroy(marketCharts.bvix);
  marketCharts.bvix = new Chart(document.getElementById("d-chart-bvix"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Model-based", data: mb, borderColor: C.mb, backgroundColor: C.mbF,
          fill: true, borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: "Model-free",  data: mf, borderColor: C.mf, borderDash: [4, 3],
          fill: false, borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ],
    },
    options: {
      maintainAspectRatio: false, responsive: true,
      animation: { duration: 400, easing: "easeOutQuart" },
      plugins: {
        legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line" } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(3)}`,
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "horizon τ", color: "#a1a1a6", font: { size: 10 } } },
        y: { ticks: { callback: v => v.toFixed(2) } },
      },
    },
  });
  marketCharts.bvix._oiecMarketIdx = DATA.markets.indexOf(m);
}

/* =====================================================================
   SURFACE LAB screen — live pricing + 3D surface
   ===================================================================== */
const labState = { marketIdx: 0, K: 0.50, tau: 0.25, P: 0.50, sigma: 1.0 };
let labInit = false;

function renderSurface() {
  if (!labInit) {
    setupLab();
    labInit = true;
  }
  updateLab();
  render3DSurface();
}

function setupLab() {
  // market selector
  const sel = document.getElementById("lab-market-selector");
  sel.innerHTML = "";
  DATA.markets.forEach((m, i) => {
    const b = document.createElement("button");
    b.textContent = "M.0" + (i + 1);
    b.dataset.idx = i;
    if (i === 0) b.classList.add("active");
    b.addEventListener("click", () => {
      labState.marketIdx = i;
      const M = DATA.markets[i];
      // snap sliders to this market's defaults
      labState.P = M.current_price;
      labState.sigma = M.sigma_hat;
      labState.tau = M.tau;
      labState.K = Math.round(M.current_price * 20) / 20; // nearest 0.05
      syncSliders();
      sel.querySelectorAll("button").forEach(x => x.classList.toggle("active", +x.dataset.idx === i));
      updateLab();
      render3DSurface();
    });
    sel.appendChild(b);
  });

  // initialize from market 0
  const M0 = DATA.markets[0];
  labState.P = M0.current_price;
  labState.sigma = M0.sigma_hat;
  labState.tau = M0.tau;
  labState.K = 0.50;
  syncSliders();

  // slider events
  ["lab-K", "lab-tau", "lab-P", "lab-sigma"].forEach(id => {
    const key = id.split("-")[1];
    const input = document.getElementById(id);
    input.addEventListener("input", () => {
      labState[key] = parseFloat(input.value);
      updateLab();
    });
    // cheaper: only redraw 3D on commit (mouseup), not every input event
    input.addEventListener("change", () => { render3DSurface(); });
  });
}

function syncSliders() {
  document.getElementById("lab-K").value = labState.K;
  document.getElementById("lab-tau").value = labState.tau;
  document.getElementById("lab-P").value = labState.P;
  document.getElementById("lab-sigma").value = labState.sigma;
  document.getElementById("lab-K-val").textContent = labState.K.toFixed(2);
  document.getElementById("lab-tau-val").textContent = labState.tau.toFixed(2);
  document.getElementById("lab-P-val").textContent = labState.P.toFixed(2);
  document.getElementById("lab-sigma-val").textContent = labState.sigma.toFixed(3);
}

function updateLab() {
  syncSliders();
  const { K, tau, P, sigma } = labState;
  const c = engine.call(P, K, sigma, tau);
  const p = engine.put(P, K, sigma, tau);
  const g = engine.greeks(P, K, sigma, tau);
  document.getElementById("lab-call").textContent = c.toFixed(4);
  document.getElementById("lab-put").textContent  = p.toFixed(4);
  document.getElementById("lab-dc").textContent   = g.deltaC.toFixed(3);
  document.getElementById("lab-dp").textContent   = g.deltaP.toFixed(3);
  document.getElementById("lab-g").textContent    = g.gamma.toFixed(3);
  document.getElementById("lab-v").textContent    = g.vega.toFixed(3);
  document.getElementById("lab-th").textContent   = g.theta.toFixed(3);
  document.getElementById("lab-surface-sub").textContent =
    `P=${P.toFixed(2)}  σ=${sigma.toFixed(2)}  K=${K.toFixed(2)}  τ=${tau.toFixed(2)}`;
}

function render3DSurface() {
  const container = document.getElementById("surface-3d");
  if (!window.Plotly) {
    container.innerHTML = `
      <div style="display:grid;place-items:center;height:100%;padding:40px;text-align:center;color:var(--ink-2);font-family:var(--mono);font-size:12px;letter-spacing:0.06em;">
        <div>
          <div style="font-size:40px;color:var(--ink-3);margin-bottom:12px;">◩</div>
          3D surface requires Plotly.js<br/>
          <span style="color:var(--ink-3);font-size:10.5px;text-transform:uppercase;letter-spacing:0.16em;">cdn.plot.ly unreachable</span>
        </div>
      </div>`;
    return;
  }
  const { P, sigma } = labState;
  // Build a grid: K × τ → call premium
  const nK = 24, nTau = 20;
  const Ks = [], taus = [];
  for (let i = 0; i < nK; i++) Ks.push(0.05 + (0.95 - 0.05) * i / (nK - 1));
  for (let j = 0; j < nTau; j++) taus.push(0.02 + (1.50 - 0.02) * j / (nTau - 1));
  const Z = taus.map(t => Ks.map(K => engine.call(P, K, sigma, t)));

  const data = [{
    type: "surface",
    x: Ks,
    y: taus,
    z: Z,
    colorscale: [
      [0.0, "rgba(26, 86, 219, 0.1)"],
      [0.3, "rgba(26, 86, 219, 0.45)"],
      [0.6, "rgba(26, 86, 219, 0.75)"],
      [1.0, "rgba(26, 86, 219, 1.0)"],
    ],
    showscale: false,
    contours: {
      x: { show: true, color: "rgba(26, 86, 219, 0.15)", width: 1 },
      y: { show: true, color: "rgba(26, 86, 219, 0.15)", width: 1 },
      z: { show: false },
    },
    lighting: { ambient: 0.7, diffuse: 0.6, specular: 0.2, roughness: 0.7 },
  }];

  const layout = {
    autosize: true,
    margin: { l: 0, r: 0, t: 0, b: 0 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Instrument Sans, sans-serif", size: 11, color: "#6e6e73" },
    scene: {
      xaxis: { title: "strike K", backgroundcolor: "rgba(0,0,0,0)", gridcolor: "#e5e5ea", zerolinecolor: "#e5e5ea", color: "#6e6e73" },
      yaxis: { title: "horizon τ", backgroundcolor: "rgba(0,0,0,0)", gridcolor: "#e5e5ea", zerolinecolor: "#e5e5ea", color: "#6e6e73" },
      zaxis: { title: "call premium", backgroundcolor: "rgba(0,0,0,0)", gridcolor: "#e5e5ea", zerolinecolor: "#e5e5ea", color: "#6e6e73" },
      camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } },
      aspectratio: { x: 1, y: 1, z: 0.7 },
    },
  };

  Plotly.react("surface-3d", data, layout, {
    displayModeBar: false,
    responsive: true,
  });
}

/* =====================================================================
   BVIX screen
   ===================================================================== */
let bvixInit = { cross: null, term: null };

function renderBVIX() {
  const sum = document.getElementById("bvix-summary");
  sum.innerHTML = "";
  DATA.markets.forEach(m => {
    const el = document.createElement("div");
    el.className = "card";
    const diff = m.bvix_model_based - m.bvix_model_free;
    const diffBp = (diff * 1000).toFixed(1);
    const chipClass = diff >= 0 ? "up" : "";
    el.innerHTML = `
      <div class="venue">${m.platform}</div>
      <div class="title">${m.name}</div>
      <div class="bvix-num">${fmt.num(m.bvix_model_free, 3)}</div>
      <div class="bvix-sub">
        <span>model-based ${fmt.num(m.bvix_model_based, 3)}</span>
        <span class="delta-chip ${chipClass}">${diff >= 0 ? "+" : ""}${diffBp}bp</span>
      </div>
    `;
    sum.appendChild(el);
  });

  drawBVIXCross();
  drawBVIXTerm();
}

function drawBVIXCross() {
  if (!window.Chart) return;

  // Sort markets by model-free BVIX descending, so the eye goes to the most
  // volatile market first. Keep a mapping back to the original index for
  // tooltip display.
  const sorted = DATA.markets
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.bvix_model_free - a.m.bvix_model_free);

  const labels    = sorted.map(({ i }) => "M.0" + (i + 1));
  const dataMF    = sorted.map(({ m }) => m.bvix_model_free);
  const dataMB    = sorted.map(({ m }) => m.bvix_model_based);
  const sortedIdx = sorted.map(({ i }) => i);

  if (bvixInit.cross) {
    const c = bvixInit.cross;
    c.data.labels            = labels;
    c.data.datasets[0].data  = dataMF;
    c.data.datasets[1].data  = dataMB;
    c._oiecSortedIdx         = sortedIdx;
    c.update("active");
    return;
  }

  bvixInit.cross = new Chart(document.getElementById("bvix-chart-cross"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Model-free",  data: dataMF, backgroundColor: C.put, borderRadius: 6, barThickness: 28 },
        { label: "Model-based", data: dataMB, backgroundColor: C.mb,  borderRadius: 6, barThickness: 28 },
      ],
    },
    options: {
      maintainAspectRatio: false, responsive: true,
      animation: { duration: 500, easing: "easeOutQuart" },
      plugins: {
        legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "rect" } },
        tooltip: {
          callbacks: {
            title: items => {
              const sortedI = items[0].dataIndex;
              const origI = bvixInit.cross._oiecSortedIdx[sortedI];
              const m = DATA.markets[origI];
              return m.platform + " · " + m.name.slice(0, 50);
            },
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(3)}`,
            afterBody: items => {
              const sortedI = items[0].dataIndex;
              const origI = bvixInit.cross._oiecSortedIdx[sortedI];
              const m = DATA.markets[origI];
              return [
                `σ̂: ${m.sigma_hat.toFixed(3)}`,
                `τ: ${fmt.years(m.tau)}`,
                `TTR: ${fmt.years(m.time_to_resolution_years)}`,
              ];
            },
          },
        },
      },
      scales: {
        y: { ticks: { callback: v => v.toFixed(2) }, title: { display: true, text: "BVIX" } },
      },
    },
  });
  bvixInit.cross._oiecSortedIdx = sortedIdx;
}

function drawBVIXTerm() {
  if (!window.Chart) return;
  const horizons = [];
  for (let i = 1; i <= 20; i++) horizons.push(0.05 * i);
  const palette = [C.call, C.put, C.mb, "#6e6e73"];
  const labels  = horizons.map(t => fmt.years(t));
  const datasets = DATA.markets.map((m, i) => {
    const baseMF = m.bvix_model_free / (m.sigma_hat * Math.sqrt(m.tau));
    return {
      label:           "M.0" + (i + 1),
      data:            horizons.map(t => m.sigma_hat * Math.sqrt(t) * baseMF),
      borderColor:     palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + "18",
      fill:            false,
      pointRadius:     0,
      borderWidth:     2,
      tension:         0.2,
    };
  });

  if (bvixInit.term) {
    const c = bvixInit.term;
    c.data.labels   = labels;
    c.data.datasets.forEach((ds, idx) => {
      ds.data = datasets[idx] ? datasets[idx].data : ds.data;
    });
    c.update("active");
    return;
  }

  bvixInit.term = new Chart(document.getElementById("bvix-chart-term"), {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false, responsive: true,
      animation: { duration: 500, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line" } },
        tooltip: {
          callbacks: {
            title: items => `horizon ${items[0].label}`,
            label: ctx => {
              const m = DATA.markets[ctx.datasetIndex];
              return `${m.name.slice(0, 40)}: ${ctx.parsed.y.toFixed(3)}`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "horizon τ" }, ticks: { maxTicksLimit: 8 } },
        y: { ticks: { callback: v => v.toFixed(2) }, title: { display: true, text: "model-free BVIX" } },
      },
    },
  });
}

/* =====================================================================
   ARBITRAGE screen — calculator + history scrubber
   ===================================================================== */
const arbState = { marketIdx: 0, capital: 100000, spreadOverride: null, scrubT: 149, playing: false, timer: null };
let arbInit = false;

function renderArb() {
  if (!arbInit) {
    setupArb();
    arbInit = true;
  }
  updateArb();
  updateScrubber();
}

function setupArb() {
  const sel = document.getElementById("arb-market");
  DATA.markets.forEach((m, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = "M.0" + (i + 1) + " · " + m.platform + " · " + m.name.slice(0, 46);
    sel.appendChild(o);
  });
  sel.addEventListener("change", (e) => {
    arbState.marketIdx = +e.target.value;
    arbState.spreadOverride = null;
    document.getElementById("arb-spread").value = "";
    arbState.scrubT = DATA.markets[arbState.marketIdx].history_prices.length - 1;
    document.getElementById("scrub-slider").value = arbState.scrubT;
    updateArb();
    updateScrubber(true);
  });

  document.getElementById("arb-capital").addEventListener("input", (e) => {
    arbState.capital = Math.max(1000, +e.target.value || 100000);
    updateArb();
  });
  document.getElementById("arb-spread").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    arbState.spreadOverride = Number.isFinite(v) && v > 0 ? v : null;
    updateArb();
  });

  // scrubber
  const slider = document.getElementById("scrub-slider");
  const n = DATA.markets[0].history_prices.length;
  slider.max = n - 1;
  slider.value = n - 1;
  arbState.scrubT = n - 1;
  slider.addEventListener("input", (e) => {
    arbState.scrubT = +e.target.value;
    updateScrubber();
  });

  document.getElementById("scrub-play").addEventListener("click", toggleScrubPlay);
}

function updateArb() {
  const m = DATA.markets[arbState.marketIdx];
  const a = m.arbitrage;
  const sb = arbState.spreadOverride ?? a.spread_before_cents;
  const sa = (arbState.spreadOverride ?? a.spread_before_cents) / a.compression_factor;

  // annualised returns
  const annB = (sb / 100) / m.time_to_resolution_years;
  const annA = (sa / 100) / m.tau;
  // dollar P&L at current capital
  const plB = arbState.capital * (sb / 100);
  const plA = arbState.capital * (sa / 100);
  // capital-recycling frequency (# trades per year via OIEC)
  const turnover = 1 / m.tau;
  const plAyr = plA * turnover;

  document.getElementById("arb-ann-before").textContent = fmt.pctSign(annB);
  document.getElementById("arb-sub-before").textContent =
    `${fmt.money(plB)} over ${fmt.years(m.time_to_resolution_years)}`;
  document.getElementById("arb-ann-after").textContent = fmt.pctSign(annA);
  document.getElementById("arb-sub-after").textContent =
    `${fmt.money(plA)} per cycle · ${turnover.toFixed(1)}×/yr → ${fmt.money(plAyr)}`;

  // comparison bars
  const maxS = Math.max(sb, sa);
  document.getElementById("arb-bar-sb").style.width = (sb / maxS * 100) + "%";
  document.getElementById("arb-bar-sa").style.width = Math.max(sa / maxS * 100, 1.5) + "%";
  document.getElementById("arb-val-sb").textContent = sb.toFixed(2) + "¢";
  document.getElementById("arb-val-sa").textContent = sa.toFixed(3) + "¢";

  const maxH = Math.max(m.time_to_resolution_years, m.tau);
  document.getElementById("arb-bar-hb").style.width = (m.time_to_resolution_years / maxH * 100) + "%";
  document.getElementById("arb-bar-ha").style.width = Math.max(m.tau / maxH * 100, 1.5) + "%";
  document.getElementById("arb-val-hb").textContent = fmt.years(m.time_to_resolution_years);
  document.getElementById("arb-val-ha").textContent = fmt.years(m.tau);
}

/* Scrubber chart state — mirrors historyChartState but for the arb screen */
const scrubChartState = {
  marketIdx: -1,
  chart:     null,
  series:    null,
  marker:    null,       // a line series with one point, acting as cursor
  lastTs:    0,
};

function mountScrubChart() {
  if (!window.LightweightCharts) return null;
  const el = document.getElementById("scrub-chart");
  el.innerHTML = "";
  const chart = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: el.clientHeight || 200,
    layout: { background: { color: "transparent" }, textColor: "#6e6e73",
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              attributionLogo: false },
    grid: {
      vertLines: { color: "#eeeef2", style: 1 },
      horzLines: { color: "#eeeef2", style: 1 },
    },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    handleScale: false, handleScroll: false,
  });
  const ro = new ResizeObserver(() => {
    if (el.clientWidth && el.clientHeight) chart.resize(el.clientWidth, el.clientHeight);
  });
  ro.observe(el);
  return chart;
}

function updateScrubber(rebuildChart = false) {
  const m = DATA.markets[arbState.marketIdx];
  const t = arbState.scrubT;
  const P = m.history_prices[t];
  const ts = m.history_timestamps[t];

  const c = engine.call(P, Math.round(P * 20) / 20, m.sigma_hat, m.tau);
  const p = engine.put(P, Math.round(P * 20) / 20, m.sigma_hat, m.tau);
  const bvix = m.sigma_hat * Math.sqrt(m.tau) * Math.sqrt(Math.max(P * (1 - P), 1e-6)) * 2;

  document.getElementById("scrub-price").textContent = fmt.pctRaw(P, 1) + "¢";
  document.getElementById("scrub-call").textContent = c.toFixed(4);
  document.getElementById("scrub-put").textContent = p.toFixed(4);
  document.getElementById("scrub-bvix").textContent = bvix.toFixed(3);
  document.getElementById("scrub-time").textContent = fmt.dateLong(ts);

  if (!window.LightweightCharts) return;

  const raw = m.history_timestamps.map((iso, k) => ({
    time: Math.floor(new Date(iso).getTime() / 1000),
    value: m.history_prices[k],
  }));

  const marketChanged = scrubChartState.marketIdx !== arbState.marketIdx;
  if (marketChanged || !scrubChartState.chart || rebuildChart) {
    if (scrubChartState.chart) {
      scrubChartState.chart.remove();
      scrubChartState.chart = null;
    }
    scrubChartState.chart = mountScrubChart();
    scrubChartState.marketIdx = arbState.marketIdx;
    scrubChartState.series = scrubChartState.chart.addAreaSeries({
      lineColor: "#1a56db",
      topColor: "rgba(26, 86, 219, 0.22)",
      bottomColor: "rgba(26, 86, 219, 0)",
      lineWidth: 2,
      priceFormat: { type: "custom", minMove: 0.001, formatter: v => (v * 100).toFixed(1) + "¢" },
    });
    scrubChartState.series.setData(raw);
    scrubChartState.lastTs = raw.length ? raw[raw.length - 1].time : 0;
    scrubChartState.chart.timeScale().fitContent();
  } else {
    // Incremental: push any new points
    const newPts = raw.filter(r => r.time > scrubChartState.lastTs);
    newPts.forEach(pt => scrubChartState.series.update(pt));
    if (newPts.length) scrubChartState.lastTs = newPts[newPts.length - 1].time;
  }

  // Move the cursor (priceLine) to the scrubbed-to point
  if (scrubChartState.cursor) {
    scrubChartState.series.removePriceLine(scrubChartState.cursor);
  }
  scrubChartState.cursor = scrubChartState.series.createPriceLine({
    price: P,
    color: "#1a56db",
    lineWidth: 1,
    lineStyle: 2,   // dashed
    axisLabelVisible: true,
    title: `t=${t}`,
  });
}

function toggleScrubPlay() {
  const btn = document.getElementById("scrub-play");
  const slider = document.getElementById("scrub-slider");
  const n = DATA.markets[arbState.marketIdx].history_prices.length;
  if (arbState.playing) {
    clearInterval(arbState.timer);
    arbState.playing = false;
    btn.textContent = "▶";
    return;
  }
  if (arbState.scrubT >= n - 1) arbState.scrubT = 0;
  arbState.playing = true;
  btn.textContent = "⏸";
  arbState.timer = setInterval(() => {
    arbState.scrubT++;
    if (arbState.scrubT >= n) {
      clearInterval(arbState.timer);
      arbState.playing = false;
      btn.textContent = "▶";
      arbState.scrubT = n - 1;
    }
    slider.value = arbState.scrubT;
    updateScrubber();
  }, 60);
}

/* =====================================================================
   Bootstrap
   ===================================================================== */
async function boot() {
  try {
    await loadData();
    applyChartDefaults();

    // status badges
    document.getElementById("status-tag").textContent =
      fmt.time(DATA.generated_at) + " · " + SRC;
    document.getElementById("foot-gen").textContent = new Date(DATA.generated_at).toUTCString();
    document.getElementById("foot-src").textContent = SRC;

    document.getElementById("loading").style.display = "none";
    document.getElementById("main").style.display = "block";

    if (!location.hash) location.hash = "#/";
    route();

    console.info("[OIEC] booted · source:", SRC, "· markets:", DATA.markets.length);

    // If we're being served over HTTP(S), try to open a live WebSocket.
    // This is a no-op on file:// because WS from file:// is blocked in most browsers.
    if (location.protocol === "http:" || location.protocol === "https:") {
      liveFeed.connect();
    } else {
      setLiveState("offline", "file://");
    }
  } catch (err) {
    document.getElementById("loading").style.display = "none";
    const e = document.getElementById("error");
    e.style.display = "block";
    document.getElementById("error-detail").textContent = err.message;
    console.error(err);
  }
}

/* =====================================================================
   Live feed — WebSocket client
   -----
   Connects to ws(s)://<host>/ws. Every message is a full data.json payload
   from the backend poller. On each message we swap DATA and re-render the
   active screen in a way that preserves interactive state:

   - Home / Markets / BVIX: full re-render each tick (they're derived views)
   - Surface Lab: do NOT re-render — its output is driven by local sliders
     over the local pricing engine, not by the payload directly. We only
     refresh the underlying market metadata (tau, sigma, P) if the user
     hasn't touched the sliders recently.
   - Arb: update numbers without rebuilding the scrubber chart while the
     user is actively playing or dragging.

   Connection states shown in the nav pulse:
     connecting · live · stale · offline
   ===================================================================== */
const liveFeed = (() => {
  let ws = null;
  let retry = 0;
  let staleTimer = null;
  const STALE_MS = (window.OIEC_CONFIG && window.OIEC_CONFIG.stale_ms) || 15000;
  let backoffMs = 1000;

  function url() {
    const base = backendUrl();
    if (base) {
      // Translate https://x.onrender.com → wss://x.onrender.com/ws
      // and        http://x                → ws://x/ws
      const u = new URL(base);
      const proto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${u.host}/ws`;
    }
    // Same-origin (backend serves the dashboard)
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    setLiveState("connecting", "—");
    try {
      ws = new WebSocket(url());
    } catch (e) {
      console.error("[OIEC] ws construct failed", e);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      retry = 0;
      backoffMs = 1000;
      console.info("[OIEC] ws open");
      setLiveState("live", fmt.time(new Date().toISOString()));
    });

    ws.addEventListener("message", (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (!payload || !payload.markets) return;
        onLivePayload(payload);
      } catch (e) {
        console.error("[OIEC] bad ws payload", e);
      }
    });

    ws.addEventListener("close", () => {
      console.warn("[OIEC] ws closed");
      setLiveState("offline", "reconnecting…");
      scheduleReconnect();
    });

    ws.addEventListener("error", (e) => {
      console.warn("[OIEC] ws error", e);
      // close event follows; handler above reconnects
    });
  }

  function scheduleReconnect() {
    retry++;
    const wait = Math.min(backoffMs * Math.pow(1.6, Math.min(retry, 6)), 20000);
    setTimeout(connect, wait);
  }

  function armStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => setLiveState("stale", "no tick"), STALE_MS);
  }

  function onLivePayload(payload) {
    DATA = payload;
    SRC = "live";
    const meta = payload._meta || {};
    const src = meta.kalshi_ok ? "Polymarket+Kalshi" : "Polymarket";
    setLiveState("live", `${src} · t${meta.tick ?? "?"}`);
    armStaleTimer();

    // Footer provenance
    const fg = document.getElementById("foot-gen");
    const fs = document.getElementById("foot-src");
    if (fg) fg.textContent = new Date(payload.generated_at).toUTCString();
    if (fs) fs.textContent = "live · " + src;

    // Route-aware re-render
    const hash = location.hash.replace(/^#/, "") || "/";
    switch (hash) {
      case "/":
        renderHome();
        break;
      case "/markets":
        renderMarkets();
        // If detail pane is open for a given market, update its charts in place
        const detailEl = document.getElementById("market-detail");
        if (detailEl && detailEl.classList.contains("open")) {
          const titleEl = document.getElementById("d-title");
          const name = titleEl ? titleEl.textContent : "";
          const i = DATA.markets.findIndex(m => m.name === name);
          if (i >= 0) {
            const m = DATA.markets[i];
            // Update scalar readouts directly (no chart rebuild)
            document.getElementById("d-price").innerHTML =
              `${fmt.pctRaw(m.current_price, 1)}<small>¢</small>`;
            document.getElementById("d-sigma").textContent = fmt.num(m.sigma_hat, 3);
            document.getElementById("d-bvix-mf").textContent = fmt.num(m.bvix_model_free, 3);
            document.getElementById("d-bvix-mb").textContent = fmt.num(m.bvix_model_based, 3);
            document.getElementById("d-varswap").textContent = fmt.num(m.variance_swap_strike, 4);
            // Strike charts (surface, bvix term) — rebuild, they're cheap and strike-indexed
            drawSurfaceChart(m);
            drawGreeksTable(m);
            drawBVIXChart(m);
            // History chart: INCREMENTAL, not a rebuild
            updateHistoryChartIncremental(m);
          }
        }
        break;
      case "/surface":
        // Lab is slider-driven; only sync the market selector state. If the
        // user hasn't bumped a slider in a while, we refresh the baseline
        // from the freshest market data.
        if (labInit && surfaceIsIdle()) {
          const M = DATA.markets[labState.marketIdx];
          if (M) {
            labState.P = M.current_price;
            labState.sigma = M.sigma_hat;
            labState.tau = M.tau;
            syncSliders();
            updateLab();
          }
        }
        break;
      case "/bvix":
        renderBVIX();
        break;
      case "/arb":
        // Don't clobber a running scrubber playback
        if (arbInit && !arbState.playing) {
          updateArb();
          // keep scrubber position; just refresh readout in case market data moved
          updateScrubber();
        }
        break;
    }
  }

  return { connect };
})();

/* Track whether the user is actively interacting with the Surface Lab
   sliders. "Idle" = no slider event for 3 seconds. */
let _lastLabInteraction = 0;
function surfaceIsIdle() {
  return Date.now() - _lastLabInteraction > 3000;
}
// Hook lab sliders — set up after setupLab runs on first /surface visit.
// We do it lazily on each pointer event from those inputs.
document.addEventListener("input", (e) => {
  if (e.target && e.target.matches && e.target.matches(".lab-controls input")) {
    _lastLabInteraction = Date.now();
  }
}, true);

/* Live state pill in the nav pulse + status tag */
function setLiveState(state, label) {
  const tag = document.getElementById("status-tag");
  const pulse = document.querySelector(".nav-status .pulse");
  if (!tag || !pulse) return;

  tag.textContent = label;
  pulse.style.boxShadow = "";  // reset animation keyframe color override

  const colors = {
    connecting: "#a1a1a6",
    live:       "#047857",     // green
    stale:      "#b45309",     // amber
    offline:    "#b91c1c",     // red
  };
  const c = colors[state] || colors.offline;
  pulse.style.background = c;
  pulse.style.animation = state === "live" ? "pulse 2.4s infinite" : "none";
}

/* ====================================================================
   Tutorial / explain layer
   --------------------------------------------------------------------
   Any element with a data-explain="key" attribute becomes hoverable
   (tooltip appears) and clickable (pinned into the side panel). The
   content dictionary below is the single source of truth for what
   each term/tool does, how to read it, and why it's useful.
   ==================================================================== */

const EXPLAIN = {
  // ---------- OIEC core concept ----------
  "oiec": {
    title: "OIEC",
    label: "The derivative layer",
    content: `<strong>Option-Implied Event Contracts</strong> are call and put options written on
      prediction-market probabilities. Instead of holding a binary "will Democrat win 2028?"
      contract for two years until resolution, you can trade a 3-month OIEC that settles on
      whatever probability the market implies at expiry. This turns multi-year capital lockups
      into 3-month cycles — the crux of the research.`,
  },
  "jacobi-sde": {
    title: "Jacobi diffusion",
    label: "Underlying model",
    content: `Prices of prediction markets live strictly in [0,1], so you can't model them with
      Black-Scholes geometric Brownian motion (which drifts to infinity). The Jacobi SDE
      <span class="formula">dP = σ·√(P(1−P))·dW</span> naturally stays bounded — volatility
      vanishes at P=0 and P=1, exactly where you'd expect in a market that's
      "decided." Closed-form option prices and Greeks follow from this dynamic.`,
  },
  "bvix-definition": {
    title: "BVIX",
    label: "Belief Volatility Index",
    content: `The <strong>Belief Volatility Index</strong> is the VIX analogue for prediction
      markets — the market-implied volatility of the underlying probability, not of an asset
      price. Think of it as how "settled" the crowd is. A BVIX of 0.10 means low uncertainty
      (the probability is unlikely to move much); 0.80 means high (potentially large swings).`,
  },
  "bvix-model-free": {
    title: "Model-free BVIX",
    label: "Replicated, not modelled",
    content: `Computed directly from the <strong>variance-swap strike</strong> — the weighted
      integral of OTM calls and puts across strikes. This is model-free because it uses no
      assumption about the underlying dynamics; it's pure replication from option prices.
      When this diverges from model-based BVIX, the market is pricing skew the Jacobi model
      doesn't capture.`,
  },
  "bvix-model-based": {
    title: "Model-based BVIX",
    label: "Jacobi-implied",
    content: `Computed from the calibrated σ̂ under the assumption that prices follow the
      Jacobi SDE. Specifically <span class="formula">BVIX = σ̂·√(P(1−P))·√τ · c</span> for a
      normalization constant c. Useful as a benchmark — deviations from model-free BVIX
      signal mispricing or model misspecification.`,
  },
  "sigma-hat": {
    title: "σ̂",
    label: "Calibrated volatility",
    content: `Rolling estimate of the Jacobi σ parameter from the market's own price history.
      Uses the fact that under the Jacobi SDE, the normalized increment
      <span class="formula">(P_{t+dt} − P_t) / √(P_t(1−P_t))</span> has variance σ²·dt. Winsorized
      to resist single-tick glitches. This is the only input the pricing engine needs.`,
  },
  "tau": {
    title: "τ (tau)",
    label: "OIEC expiry",
    content: `Horizon of the option — when it settles. Typically much shorter than the
      underlying event's resolution date. For a 2028 election market (resolves Nov 2028),
      a τ=0.25y OIEC settles in ~3 months on the market-implied probability at that time.
      This is what lets you recycle capital.`,
  },
  "ttr": {
    title: "TTR",
    label: "Time to resolution",
    content: `<strong>Time to Resolution</strong> of the underlying prediction market. For
      "Democrat wins 2028?", TTR ≈ 2.5 years from today. Capital backing a direct position
      in the prediction market is locked for TTR years. OIECs shorten the effective lockup
      to τ — the main economic claim of the paper.`,
  },
  "variance-swap-k": {
    title: "Variance-swap strike",
    label: "Fair vol² over τ",
    content: `The strike K for which a variance swap (pay fixed K, receive realized variance)
      has zero initial cost. Computed from the full option surface via
      <span class="formula">K = 2·∫ C(k)/k² dk + 2·∫ P(k)/k² dk</span>. Model-free BVIX is
      just <span class="formula">√(K·τ)</span> rescaled.`,
  },

  // ---------- Greeks ----------
  "delta-c": {
    title: "δ call",
    label: "Call delta",
    content: `Sensitivity of the call price to a 1-unit move in the probability.
      <span class="formula">δc = ∂C/∂P</span>. Always in [0,1]: at-the-money ≈ 0.5, deep
      in-the-money ≈ 1, deep out ≈ 0. Practically: if δc=0.5, your call gains ~0.5¢ for
      every 1¢ the underlying probability rises.`,
  },
  "delta-p": {
    title: "δ put",
    label: "Put delta",
    content: `Sensitivity of the put price to the probability. Always in [-1,0].
      Put-call parity in prediction markets: <span class="formula">δc − δp = 1</span>
      (not just ≤ as in BS).`,
  },
  "gamma": {
    title: "Γ (gamma)",
    label: "Delta's derivative",
    content: `How fast delta changes. <span class="formula">Γ = ∂²C/∂P²</span>. Highest at
      the strike. For prediction markets Γ can be quite large because the probability has
      nowhere to go past [0,1] — near the boundary, small probability moves cause large
      payoff changes.`,
  },
  "vega": {
    title: "ν (vega)",
    label: "Vol sensitivity",
    content: `How much the option price changes per unit change in σ̂.
      <span class="formula">ν = ∂C/∂σ</span>. Maximum at-the-money. If σ̂ rises 0.10 and
      vega is 0.05, the option gains ~0.005 in premium.`,
  },
  "theta": {
    title: "Θ (theta)",
    label: "Time decay",
    content: `Option price decay per unit of calendar time. <span class="formula">Θ = ∂C/∂t</span>.
      Always negative for long option positions — the seller keeps this as "rent." In
      prediction markets with τ of a few months, theta concentrates in the final weeks
      as uncertainty resolves.`,
  },

  // ---------- Arbitrage mechanics ----------
  "cross-spread": {
    title: "Cross-venue spread",
    label: "The arb opportunity",
    content: `Gap between Polymarket and Kalshi prices on the same (or equivalent) event.
      Before OIECs this spread is a long-duration bet — you buy low on one venue, sell high
      on the other, and lock capital until the event resolves.`,
  },
  "compression-factor": {
    title: "Compression factor",
    label: "How much shorter",
    content: `Ratio of TTR to τ. A compression factor of 30 means the OIEC lets you recycle
      capital 30× per year vs holding the underlying to resolution. Combined with the tighter
      OIEC spread that follows from the derivative layer, this is where the ~100× arbitrage
      improvement comes from.`,
  },
  "horizon-shortening": {
    title: "Horizon shortening",
    label: "The core claim",
    content: `Under naive arbitrage, you earn <span class="formula">spread / TTR</span> annualized.
      With OIECs, you earn <span class="formula">spread_OIEC / τ</span> per cycle, cycling
      <span class="formula">1/τ</span> times per year. Same spread-per-unit-time, but orders
      of magnitude more cycles.`,
  },

  // ---------- Chart / UI ----------
  "timeframe": {
    title: "Timeframe",
    label: "Candle aggregation",
    content: `Each candle aggregates all ticks inside that time window. A 1s candle shows
      each per-second poll as its own bar with auto-scaled Y-axis — use this to see
      micro-movements that would be invisible at longer intervals. 1m and higher smooth
      out noise and reveal regime changes.`,
  },
  "chartKind.line": {
    title: "Line mode",
    label: "Close-of-bucket trajectory",
    content: `Plots one point per time bucket using the close-of-bucket value. Best for
      reading the overall trend and for comparing against model outputs (σ̂, BVIX). Line
      mode trades detail for clarity.`,
  },
  "chartKind.candle": {
    title: "Candle mode",
    label: "OHLC per bucket",
    content: `Each candle shows open-high-low-close for that time bucket. Green means close
      &gt; previous close, red means close &lt; previous close, grey means unchanged.
      Wicks show intra-bucket range. For prediction markets with slow movement, shorter
      timeframes give the most useful candles.`,
  },
  "surface-lab": {
    title: "Surface Lab",
    label: "What-if pricing",
    content: `Drag the sliders to see how the entire option surface reshapes under different
      P, σ, K, τ. Lets you build intuition about the Jacobi model before committing real
      capital. The 3D surface is <span class="formula">C(K, τ)</span> — call premium over
      the joint strike × expiry grid.`,
  },
  "live-status": {
    title: "Live status",
    label: "Data freshness",
    content: `Green pulse = WebSocket connected and ticking. Amber = no tick in &gt;15 seconds
      (stale). Red = disconnected, attempting reconnect. Tick counter in the status bar
      shows how many polls the backend has completed since startup.`,
  },
  "scrubber": {
    title: "History scrubber",
    label: "Replay the past",
    content: `Drag the slider or press play to walk through the rolling price buffer. All
      option prices and Greeks recompute at each historical point under the calibrated σ̂,
      so you can see how the derivative would have behaved.`,
  },
};

/* ---- Tooltip + side panel wiring ---- */

let explainTooltipEl = null;
let explainPanelEl = null;

function ensureExplainDom() {
  if (!explainTooltipEl) {
    explainTooltipEl = document.createElement("div");
    explainTooltipEl.className = "explain-tooltip";
    document.body.appendChild(explainTooltipEl);
  }
  if (!explainPanelEl) {
    explainPanelEl = document.createElement("aside");
    explainPanelEl.className = "explain-panel";
    explainPanelEl.innerHTML = `
      <button class="panel-close" aria-label="Close">close ×</button>
      <div class="panel-body"></div>
    `;
    document.body.appendChild(explainPanelEl);
    explainPanelEl.querySelector(".panel-close").addEventListener("click", () => {
      explainPanelEl.classList.remove("open");
    });
  }
}

function positionTooltip(el) {
  const rect = el.getBoundingClientRect();
  const tw = explainTooltipEl.offsetWidth;
  const th = explainTooltipEl.offsetHeight;
  // Prefer above; flip below if it would clip
  let top = rect.top - th - 10;
  let left = rect.left + rect.width / 2 - tw / 2;
  if (top < 10) top = rect.bottom + 10;
  left = Math.max(10, Math.min(window.innerWidth - tw - 10, left));
  explainTooltipEl.style.top  = top  + "px";
  explainTooltipEl.style.left = left + "px";
}

function showExplainTooltip(el, key) {
  const e = EXPLAIN[key];
  if (!e) return;
  ensureExplainDom();
  explainTooltipEl.innerHTML = `
    <div class="title">${e.label || e.title}</div>
    <div class="body">${stripHtmlForTooltip(e.content)}</div>
    <div class="pin-hint">Click to pin for details →</div>
  `;
  explainTooltipEl.classList.add("visible");
  requestAnimationFrame(() => positionTooltip(el));
}

function hideExplainTooltip() {
  if (explainTooltipEl) explainTooltipEl.classList.remove("visible");
}

/** Tooltip shows a short version — strip the <span class="formula"> markup and
    truncate to ~160 chars. The full richness appears in the pinned side panel. */
function stripHtmlForTooltip(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const text = tmp.textContent || "";
  return text.length > 200 ? text.slice(0, 197) + "…" : text;
}

function pinExplain(key) {
  const e = EXPLAIN[key];
  if (!e) return;
  ensureExplainDom();
  const body = explainPanelEl.querySelector(".panel-body");
  body.innerHTML = `
    <span class="tag">${e.label || "concept"}</span>
    <h3>${e.title}</h3>
    <div class="section">
      <div class="label">What it is</div>
      <div class="content">${e.content}</div>
    </div>
    <div class="footer">From the OIEC research paper · Shah, 2026</div>
  `;
  explainPanelEl.classList.add("open");
  hideExplainTooltip();
}

(function initExplainLayer() {
  // Hover: show tooltip
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-explain]");
    if (!el) return;
    const key = el.dataset.explain;
    if (!EXPLAIN[key]) return;
    showExplainTooltip(el, key);
  });
  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest("[data-explain]");
    if (!el) return;
    // Only hide if we're moving OUT of the element, not to a child of it
    if (el.contains(e.relatedTarget)) return;
    hideExplainTooltip();
  });

  // Click: pin to side panel (unless the click lands on a button that has its
  // own click behavior — e.g. the tf-toggle buttons. In that case we wait a
  // tick and let their handler fire normally, then pin after.)
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-explain]");
    if (!el) return;
    // Don't steal clicks from actionable controls
    if (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT") {
      // Shift+click opens the explain panel even on actionable controls, as an escape
      if (!e.shiftKey) return;
    }
    e.preventDefault();
    pinExplain(el.dataset.explain);
  });

  // Escape closes the panel
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && explainPanelEl && explainPanelEl.classList.contains("open")) {
      explainPanelEl.classList.remove("open");
    }
  });
})();

boot();
