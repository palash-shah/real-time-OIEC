# OIEC Demo — live backend + dashboard

Local demo of the Option-Implied Event Contracts framework. Polls
Polymarket (public Gamma API) and Kalshi (authenticated v2) every ~3s,
runs the Jacobi pricing engine, and streams the result to a dashboard
over WebSocket.

## Structure

```
oiec-demo/
├── backend/
│   ├── main.py               FastAPI app (run this)
│   ├── pricing.py            Jacobi-Bachelier engine
│   ├── calibration.py        Rolling sigma estimator
│   ├── polymarket.py         Gamma API client (public)
│   ├── kalshi.py             Kalshi v2 client (RSA-PSS signed)
│   ├── poller.py             The 3s loop
│   ├── markets_config.py     Which markets to watch
│   ├── .env.example          Copy → .env, fill in creds
│   └── requirements.txt
└── dashboard-v2/             Frontend, served by backend at /
```

## One-time setup

1. **Revoke the old Kalshi key and generate a new one.** Go to
   kalshi.com → Settings → API Keys. Delete any old key. Generate new.
   Download the private-key PEM. Save it somewhere safe on your laptop.

2. **Install Python deps:**
   ```bash
   cd oiec-demo/backend
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Copy your PEM file into the backend folder (locally):**
   ```bash
   cp ~/Downloads/kalshi_private_key.pem ./kalshi_private_key.pem
   chmod 600 ./kalshi_private_key.pem
   ```
   The `chmod 600` makes it readable only by you. Important.

4. **Create your `.env`:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and fill in:
   ```
   KALSHI_KEY_ID=<your new UUID from Kalshi>
   KALSHI_PEM_PATH=./kalshi_private_key.pem
   KALSHI_ENV=prod         # or 'demo' to test against fake-money sandbox
   ```

5. **Sanity-check the Kalshi pipeline before running the full stack:**
   ```bash
   KALSHI_KEY_ID=<your-id> KALSHI_PEM_PATH=./kalshi_private_key.pem \
     python3 kalshi.py
   ```
   You should see `auth ok: True` and a few market tickers. If auth fails
   here, fix it before running the server — the poller will also fail.

## Run it

```bash
cd oiec-demo/backend
source venv/bin/activate      # if not already
python main.py
```

Then open **http://localhost:8000/** in a browser.

Within ~3 seconds of loading, the nav's live indicator should go green
and the status text should read `Polymarket+Kalshi · t1` (tick 1). Numbers
will start moving.

## What you'll see

- **Home** — the big `×` compression headline is computed live from the
  cross-venue spreads the backend is observing
- **Markets** — four live markets. The σ̂ you see here is calibrated from
  the rolling price history the backend is accumulating
- **Surface Lab** — slider-driven local pricing. Baseline market data
  (spot P, σ, τ) updates from the feed; sliders still work smoothly
- **BVIX** — variance-swap-implied belief volatility per market
- **Arbitrage** — dollar P&L on live cross-venue spreads. The scrubber
  replays the 150-point rolling buffer

## Health checks

- `curl http://localhost:8000/status` — tick count, client count, Kalshi auth status, last error
- `curl http://localhost:8000/healthz` — `{"ok": true}`
- `curl http://localhost:8000/data.json` — the latest payload as JSON

## Deploy — dashboard on GitHub Pages, backend on Render

The two halves can live on separate hosts. Dashboard (static files) goes on
GitHub Pages. Backend (live poller + WebSocket) goes on Render. They talk
over `wss://` through your configured CORS origin.

### 1. Deploy the backend to Render

1. **Push the repo** (including `render.yaml`) to GitHub.
2. Go to **render.com → New → Blueprint** and select your repo. Render
   reads `render.yaml` and creates the `oiec-backend` service.
3. Render will prompt for the secrets marked `sync: false`. Paste:
   - `KALSHI_KEY_ID` — your UUID-style key ID
   - `KALSHI_PEM_PEM` — open your PEM file in a text editor, copy **all of
     it** including the `-----BEGIN/END RSA PRIVATE KEY-----` lines, and
     paste the full text into the value field. (On Render you cannot
     reference an on-disk PEM file — the key contents go in as env var text.)
4. Click **Apply**. First build takes ~2 minutes.
5. Once live, visit `https://<your-service-name>.onrender.com/status` —
   should return JSON with `tick: 1+` and `kalshi_ok: true`.
6. **Note your service URL** — you need it for the frontend config.

Things to know about Render free tier:
- Service spins down after 15 minutes of inactivity; first request after
  that takes ~60 seconds to warm back up. Ping `/healthz` a few minutes
  before a demo to pre-warm.
- WebSocket traffic counts as activity, so it won't spin down mid-demo.
- Free tier bandwidth is 100 GB/month. Polling 4 markets at 3s is
  negligible — you'll use a fraction of a percent.

### 2. Deploy the dashboard to GitHub Pages

1. **Edit `dashboard-v2/config.js`**:
   ```js
   window.OIEC_CONFIG = {
     backend_url: "https://<your-service-name>.onrender.com",
     stale_ms: 15000,
   };
   ```
2. Commit and push.
3. On GitHub: **repo → Settings → Pages**.
4. Source: `Deploy from a branch`. Branch: `main`, folder: `/dashboard-v2`.
   Click **Save**.
5. Wait ~1 minute. Pages will publish at
   `https://<your-username>.github.io/<repo-name>/`.

The `.nojekyll` file in `dashboard-v2/` disables Jekyll processing (which
would otherwise silently hide any file starting with `_`).

### 3. Give Render the Pages origin

Back in Render → your service → Environment tab. Set:

```
OIEC_CORS_ORIGINS=https://<your-username>.github.io
```

No trailing slash. The value is just the origin — Pages serves
`https://palash-shah.github.io/real-time-OIEC/` but the CORS origin is
`https://palash-shah.github.io`.

Render will redeploy automatically after saving. ~30s.

### 4. Verify

Open `https://<your-username>.github.io/<repo-name>/` in a browser. Within
a few seconds the nav pulse should go **green** and status should read
`Polymarket+Kalshi · t1` (or `Polymarket · t1` if Kalshi auth failed).

If it stays `connecting…` or goes red:
- Open the browser devtools console. Common errors:
  - `blocked by CORS policy` → your `OIEC_CORS_ORIGINS` doesn't match. Check
    for trailing slash, or https/http mismatch.
  - `Mixed Content` → the page is https but is trying to hit http://. Your
    `backend_url` must start with `https://`.
  - `WebSocket connection failed` with no other detail → Render service is
    cold-starting. Wait 60s and reload.

## Troubleshooting

**"Kalshi auth probe failed"** in the backend logs at startup.
→ Check `.env`. Common causes: key ID typo, PEM file path wrong, key
revoked, wrong environment (prod vs demo — they have separate keys).

**Backend runs but nothing ticks.**
→ Check `/status`. If `markets_live: 0`, none of the configured slugs/tickers
are resolving. Edit `backend/markets_config.py` — slug and ticker names
change as markets resolve and relist.

**"Polymarket fetch_by_slug(...) failed: 403"** in the logs.
→ Polymarket's WAF can flag certain request signatures. Usually harmless
intermittent; the poller retries. If persistent, try adding a User-Agent
header variant in `polymarket.py`.

**Dashboard shows "file://"** in status.
→ You opened `dashboard-v2/index.html` directly instead of loading via the
backend. Go to http://localhost:8000/ instead.

**Nav pulse is red / status says "reconnecting…"**
→ WebSocket can't reach the backend. Is `python main.py` still running?
Check the terminal for crashes.

**I want to watch a different event.**
→ Edit `backend/markets_config.py`. Each entry needs at minimum either a
`polymarket_slug` or a `kalshi_ticker`. Find the slug on polymarket.com
(it's in the URL); find Kalshi tickers at kalshi.com/markets. Restart the
server.

## Security notes

- Your `.env` and `kalshi_private_key.pem` must never leave your laptop.
  `.gitignore` both. Do not paste them into any chat, email, or repo.
- The backend binds to `127.0.0.1` by default — local-only. Don't change
  to `0.0.0.0` unless you know what you're doing and add auth.
- The Kalshi client here only makes **read** calls (get market, list
  markets, check auth). It never places, cancels, or modifies orders.
  That's by design. Writing the order-placement path is a separate task
  and should be done with deliberate risk controls.
