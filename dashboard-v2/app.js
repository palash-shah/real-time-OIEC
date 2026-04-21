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
  // 1. sidecar data.js (embedded fallback for static hosting)
  if (window.OIEC_DATA && window.OIEC_DATA.markets && window.OIEC_DATA.markets.length) {
    DATA = window.OIEC_DATA;
    SRC = "data.js";
    // Don't return yet — if a backend is configured, we'll upgrade via fetch below.
  }

  // 2. fetch from backend (works cross-origin thanks to CORS)
  const base = backendUrl();
  if (base || location.protocol !== "file:") {
    try {
      const res = await fetch(backendURL("/data.json"), { cache: "no-store" });
      if (res.ok) {
        DATA = await res.json();
        SRC = base ? "backend" : "data.json";
        return;
      }
    } catch (_) { /* fall through */ }
  }

  // 3. if we already loaded from data.js, stick with it
  if (DATA) return;

  // 4. inline embed (ultimate fallback — works even on file://)
  const embed = document.getElementById("oiec-embed");
  if (embed) {
    const parsed = JSON.parse(embed.textContent);
    if (parsed && parsed.markets && parsed.markets.length) {
      DATA = parsed;
      SRC = "embedded";
      return;
    }
  }
  throw new Error(
    "No data source found.\n\n" +
    "If you deployed the dashboard to GitHub Pages, edit config.js and set\n" +
    "backend_url to your Render service URL (e.g. https://oiec-backend.onrender.com).\n\n" +
    "For local development:\n" +
    "  1. Serve the folder:  python3 -m http.server\n" +
    "  2. Place data.js next to index.html\n" +
    "  3. Re-run embed_data.py to inline data.json"
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

  const grid = document.getElementById("spotlight-grid");
  grid.innerHTML = "";
  DATA.markets.forEach((m, i) => {
    const spark = renderSparkline(m.history_prices, 240, 80);
    const el = document.createElement("div");
    el.className = "spotlight";
    el.innerHTML = `
      <div class="venue">${m.platform}</div>
      <div class="title">${m.name}</div>
      <div class="price mono">${fmt.pctRaw(m.current_price, 1)}<span class="unit">¢</span></div>
      <div class="meta">
        <div><span class="k">σ̂</span><span class="v">${fmt.num(m.sigma_hat, 3)}</span></div>
        <div><span class="k">BVIX</span><span class="v">${fmt.num(m.bvix_model_free, 3)}</span></div>
        <div><span class="k">TTR</span><span class="v">${fmt.years(m.time_to_resolution_years)}</span></div>
      </div>
      <div class="spark">${spark}</div>
    `;
    el.addEventListener("click", () => {
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
  destroy(marketCharts.surface);
  if (!window.Chart) return;
  const ctx = document.getElementById("d-chart-surface");
  marketCharts.surface = new Chart(ctx, {
    type: "line",
    data: {
      labels: m.strikes.map(s => s.toFixed(2)),
      datasets: [
        { label: "Call", data: m.call_prices, borderColor: C.call, backgroundColor: C.callF, fill: true, pointRadius: 0 },
        { label: "Put",  data: m.put_prices,  borderColor: C.put,  backgroundColor: C.putF,  fill: true, pointRadius: 0, borderDash: [5, 3] },
      ],
    },
    options: {
      maintainAspectRatio: false, responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line" } } },
      scales: {
        x: { title: { display: true, text: "strike K", color: "#a1a1a6", font: { size: 10 } } },
        y: { title: { display: true, text: "premium",  color: "#a1a1a6", font: { size: 10 } }, ticks: { callback: v => v.toFixed(2) } },
      },
    },
  });
}

function drawGreeksTable(m) {
  const tbl = document.getElementById("d-greeks");
  const atmIdx = m.strikes.reduce(
    (best, s, i) => Math.abs(s - m.current_price) < Math.abs(m.strikes[best] - m.current_price) ? i : best, 0
  );
  const want = [atmIdx - 4, atmIdx - 2, atmIdx, atmIdx + 2, atmIdx + 4];
  const pick = want.filter(j => j >= 0 && j < m.strikes.length);

  let html = `<tr><th>K</th><th>δc</th><th>δp</th><th>γ</th><th>ν</th><th>θ</th></tr>`;
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

function drawHistoryChart(m) {
  destroy(marketCharts.history);
  if (!window.Chart) return;
  const n = m.history_timestamps.length;
  const step = Math.max(1, Math.floor(n / 6));
  const labels = m.history_timestamps.map((t, i) => i % step === 0 ? fmt.date(t) : "");

  marketCharts.history = new Chart(document.getElementById("d-chart-history"), {
    type: "line",
    data: { labels, datasets: [{
      label: "P(t)",
      data: m.history_prices,
      borderColor: C.call,
      backgroundColor: (ctx) => {
        const chart = ctx.chart;
        const { ctx: cx, chartArea } = chart;
        if (!chartArea) return C.fill;
        const g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        g.addColorStop(0, "rgba(26, 86, 219, 0.20)");
        g.addColorStop(1, "rgba(26, 86, 219, 0.0)");
        return g;
      },
      fill: true,
    }] },
    options: {
      maintainAspectRatio: false, responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0 } },
        y: { min: 0, max: 1, ticks: { callback: v => (v * 100).toFixed(0) + "¢" } },
      },
    },
  });
}

function drawBVIXChart(m) {
  destroy(marketCharts.bvix);
  if (!window.Chart) return;
  const tMax = Math.min(m.time_to_resolution_years, 1.0);
  const horizons = [];
  for (let i = 1; i <= 20; i++) horizons.push(tMax * (i / 20));

  // scale model / free series so at τ we match the stored BVIX values
  const baseMB = m.bvix_model_based / (m.sigma_hat * Math.sqrt(m.tau));
  const baseMF = m.bvix_model_free  / (m.sigma_hat * Math.sqrt(m.tau));
  const mb = horizons.map(t => m.sigma_hat * Math.sqrt(t) * baseMB);
  const mf = horizons.map(t => m.sigma_hat * Math.sqrt(t) * baseMF);

  marketCharts.bvix = new Chart(document.getElementById("d-chart-bvix"), {
    type: "line",
    data: {
      labels: horizons.map(t => fmt.years(t)),
      datasets: [
        { label: "Model-based", data: mb, borderColor: C.mb, backgroundColor: C.mbF, fill: true },
        { label: "Model-free",  data: mf, borderColor: C.mf, borderDash: [4, 3], fill: false },
      ],
    },
    options: {
      maintainAspectRatio: false, responsive: true,
      plugins: { legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line" } } },
      scales: {
        x: { title: { display: true, text: "horizon τ", color: "#a1a1a6", font: { size: 10 } } },
        y: { ticks: { callback: v => v.toFixed(2) } },
      },
    },
  });
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
    el.className = "bvix-card";
    const diff = m.bvix_model_based - m.bvix_model_free;
    el.innerHTML = `
      <div class="venue">${m.platform}</div>
      <div class="title">${m.name}</div>
      <div class="ring">
        <div class="ring-val mono">${fmt.num(m.bvix_model_free, 3)}</div>
      </div>
      <div class="mono" style="text-align:center; font-size:11px; color: var(--ink-2); margin-top:8px;">
        model-based ${fmt.num(m.bvix_model_based, 3)}
        <span style="color: ${diff > 0 ? 'var(--neg)' : 'var(--pos)'}; margin-left:8px;">
          ${diff > 0 ? '+' : ''}${(diff * 1000).toFixed(1)}bp
        </span>
      </div>
    `;
    sum.appendChild(el);
  });

  drawBVIXCross();
  drawBVIXTerm();
}

function drawBVIXCross() {
  if (!window.Chart) return;
  destroy(bvixInit.cross);
  const labels = DATA.markets.map((m, i) => "M.0" + (i + 1));
  bvixInit.cross = new Chart(document.getElementById("bvix-chart-cross"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Model-free", data: DATA.markets.map(m => m.bvix_model_free), backgroundColor: C.put, borderRadius: 6, barThickness: 28 },
        { label: "Model-based", data: DATA.markets.map(m => m.bvix_model_based), backgroundColor: C.mb, borderRadius: 6, barThickness: 28 },
      ],
    },
    options: {
      maintainAspectRatio: false, responsive: true,
      plugins: {
        legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "rect" } },
        tooltip: {
          callbacks: {
            title: items => {
              const i = items[0].dataIndex;
              return DATA.markets[i].platform + " · " + DATA.markets[i].name.slice(0, 40);
            },
          },
        },
      },
      scales: { y: { ticks: { callback: v => v.toFixed(2) }, title: { display: true, text: "BVIX" } } },
    },
  });
}

function drawBVIXTerm() {
  if (!window.Chart) return;
  destroy(bvixInit.term);
  // One consistent horizon grid across markets
  const horizons = [];
  for (let i = 1; i <= 20; i++) horizons.push(0.05 * i);
  const palette = [C.call, C.put, C.mb, "#6e6e73"];
  const datasets = DATA.markets.map((m, i) => {
    const baseMF = m.bvix_model_free / (m.sigma_hat * Math.sqrt(m.tau));
    return {
      label: "M.0" + (i + 1),
      data: horizons.map(t => m.sigma_hat * Math.sqrt(t) * baseMF),
      borderColor: palette[i % palette.length],
      backgroundColor: "transparent",
      fill: false,
      pointRadius: 0,
    };
  });
  bvixInit.term = new Chart(document.getElementById("bvix-chart-term"), {
    type: "line",
    data: { labels: horizons.map(t => fmt.years(t)), datasets },
    options: {
      maintainAspectRatio: false, responsive: true,
      plugins: { legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line" } } },
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
let scrubChart = null;

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

function updateScrubber(rebuildChart = false) {
  const m = DATA.markets[arbState.marketIdx];
  const t = arbState.scrubT;
  const P = m.history_prices[t];
  const ts = m.history_timestamps[t];

  // recompute ATM call/put at this historical P using the market's σ and τ
  const c = engine.call(P, Math.round(P * 20) / 20, m.sigma_hat, m.tau);
  const p = engine.put(P, Math.round(P * 20) / 20, m.sigma_hat, m.tau);
  // simple BVIX proxy: σ · √τ scales with instantaneous variance P(1−P)
  const bvix = m.sigma_hat * Math.sqrt(m.tau) * Math.sqrt(Math.max(P * (1 - P), 1e-6)) * 2;

  document.getElementById("scrub-price").textContent = fmt.pctRaw(P, 1) + "¢";
  document.getElementById("scrub-call").textContent = c.toFixed(4);
  document.getElementById("scrub-put").textContent = p.toFixed(4);
  document.getElementById("scrub-bvix").textContent = bvix.toFixed(3);
  document.getElementById("scrub-time").textContent = fmt.dateLong(ts);

  if (!window.Chart) return;
  if (!scrubChart || rebuildChart) {
    destroy(scrubChart);
    const n = m.history_timestamps.length;
    const step = Math.max(1, Math.floor(n / 8));
    const labels = m.history_timestamps.map((t, i) => i % step === 0 ? fmt.date(t) : "");
    scrubChart = new Chart(document.getElementById("scrub-chart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "P(t)",
            data: m.history_prices,
            borderColor: C.call,
            backgroundColor: (ctx) => {
              const { ctx: cx, chartArea } = ctx.chart;
              if (!chartArea) return C.fill;
              const g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              g.addColorStop(0, "rgba(26, 86, 219, 0.2)");
              g.addColorStop(1, "rgba(26, 86, 219, 0)");
              return g;
            },
            fill: true,
            pointRadius: m.history_prices.map((_, i) => i === t ? 5 : 0),
            pointBackgroundColor: C.call,
            pointBorderColor: "#fff",
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        maintainAspectRatio: false, responsive: true,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0 } },
          y: { min: 0, max: 1, ticks: { callback: v => (v * 100).toFixed(0) + "¢" } },
        },
      },
    });
  } else {
    // just move the highlighted point
    scrubChart.data.datasets[0].pointRadius = m.history_prices.map((_, i) => i === t ? 5 : 0);
    scrubChart.update("none");
  }
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
        // If detail pane is open for a given market, re-draw its charts
        const open = document.getElementById("market-detail");
        if (open && open.classList.contains("open")) {
          const titleEl = document.getElementById("d-title");
          const name = titleEl ? titleEl.textContent : "";
          const i = DATA.markets.findIndex(m => m.name === name);
          if (i >= 0) openMarketDetail(i);
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

boot();
