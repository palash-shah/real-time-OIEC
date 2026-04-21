"""
main.py — the OIEC live backend.

Run:
    cp .env.example .env    # paste your Kalshi credentials
    python main.py

Serves:
    GET  /                  — serves the dashboard (frontend index.html)
    GET  /data.json         — the latest payload (snapshot, same shape as static file)
    GET  /status            — human-readable status
    WS   /ws                — subscribes to live payload broadcasts
    GET  /healthz           — {"ok": true}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from poller import Poller

# -------------------------------------------------------------------- setup
load_dotenv()
logging.basicConfig(
    level=os.environ.get("OIEC_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
log = logging.getLogger("oiec")

# CORS: allowed origins for the dashboard to call us from.
# Set OIEC_CORS_ORIGINS as a comma-separated list (no trailing slashes):
#   "https://palash-shah.github.io,http://localhost:8000"
# Default is permissive for local dev.
_cors_raw = os.environ.get("OIEC_CORS_ORIGINS", "*").strip()
if _cors_raw == "*":
    CORS_ORIGINS = ["*"]
else:
    CORS_ORIGINS = [o.strip().rstrip("/") for o in _cors_raw.split(",") if o.strip()]
log.info("CORS origins: %s", CORS_ORIGINS)

# The dashboard folder — relative to this file. The user arranges:
#   oiec-demo/
#     backend/main.py
#     dashboard-v2/index.html
DASHBOARD_DIR = (Path(__file__).parent.parent / "dashboard-v2").resolve()
if not DASHBOARD_DIR.is_dir():
    log.warning("dashboard-v2 not found at %s — / route will 404", DASHBOARD_DIR)


# -------------------------------------------------------------------- hub
class Hub:
    """Broadcasts the latest payload to every connected WebSocket."""
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._last: dict | None = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)
        # Send the most recent payload immediately so the new client paints
        if self._last is not None:
            try:
                await ws.send_text(json.dumps(self._last))
            except Exception:
                pass

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        self._last = payload
        dead = []
        msg = json.dumps(payload)
        async with self._lock:
            clients = list(self._clients)
        for ws in clients:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(ws)

    @property
    def last(self) -> dict | None:
        return self._last

    @property
    def n_clients(self) -> int:
        return len(self._clients)


hub = Hub()
poller = Poller(hub)


# -------------------------------------------------------------------- app
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("OIEC backend starting …")
    await poller.start()
    yield
    log.info("OIEC backend shutting down …")
    await poller.stop()


app = FastAPI(title="OIEC Live", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


# ---- REST endpoints (must register BEFORE the static catch-all) ----------
@app.get("/data.json")
async def data_snapshot():
    if hub.last is None:
        return JSONResponse({"error": "no payload yet"}, status_code=503)
    return JSONResponse(hub.last)


@app.get("/status")
async def status():
    p = hub.last
    return {
        "clients": hub.n_clients,
        "last_tick": (p or {}).get("_meta", {}).get("tick"),
        "kalshi_ok": (p or {}).get("_meta", {}).get("kalshi_ok"),
        "poll_interval_sec": (p or {}).get("_meta", {}).get("poll_interval_sec"),
        "markets_live": len((p or {}).get("markets", [])),
        "last_error": (p or {}).get("_meta", {}).get("last_error"),
        "generated_at": (p or {}).get("generated_at"),
    }


@app.get("/healthz")
async def healthz():
    return {"ok": True}


# ---- websocket -----------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await hub.connect(ws)
    client = ws.client
    log.info("ws connected from %s (total=%d)", client, hub.n_clients + 0)
    try:
        while True:
            # we don't expect messages from clients; just keep the socket alive
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(ws)
        log.info("ws disconnected from %s (total=%d)", client, hub.n_clients)


# ---- frontend serving (catch-all LAST) ----------------------------------
if DASHBOARD_DIR.is_dir():
    @app.get("/", response_class=HTMLResponse)
    async def root():
        idx = DASHBOARD_DIR / "index.html"
        return HTMLResponse(idx.read_text())

    @app.get("/{fname:path}")
    async def static_file(fname: str):
        if not fname or ".." in fname:
            return JSONResponse({"error": "not found"}, status_code=404)
        p = (DASHBOARD_DIR / fname).resolve()
        try:
            p.relative_to(DASHBOARD_DIR)
        except ValueError:
            return JSONResponse({"error": "not found"}, status_code=404)
        if not p.is_file():
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(p)


# ---- entry ---------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    # Render sets PORT automatically. Locally we fall back to OIEC_PORT or 8000.
    port = int(os.environ.get("PORT") or os.environ.get("OIEC_PORT") or "8000")
    # On Render / any cloud host, bind 0.0.0.0 so the platform can route traffic.
    # Locally, default to 127.0.0.1 so you're not exposing the server to your LAN.
    default_host = "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1"
    host = os.environ.get("OIEC_HOST", default_host)
    log.info("Starting uvicorn on %s:%d", host, port)
    uvicorn.run("main:app", host=host, port=port, reload=False, log_level="info")
