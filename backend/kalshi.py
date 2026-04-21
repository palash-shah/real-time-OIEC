"""
kalshi.py — Kalshi Trade API v2 client with RSA-PSS signing.

Docs: https://docs.kalshi.com
Auth: RSA-PSS signature over `timestamp(ms) + METHOD + path_without_query`
Headers required on every request:
  KALSHI-ACCESS-KEY         — the UUID-style key ID
  KALSHI-ACCESS-TIMESTAMP   — unix ms as string
  KALSHI-ACCESS-SIGNATURE   — base64(RSA-PSS(SHA256, DIGEST_LENGTH))

IMPORTANT: Even "public" market-data endpoints on Kalshi require auth.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

log = logging.getLogger(__name__)


PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2"
DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2"


@dataclass
class KalshiQuote:
    ticker: str
    title: str
    yes_price: float       # normalized to [0, 1]
    volume: float
    yes_bid: Optional[float]
    yes_ask: Optional[float]
    timestamp_s: float
    raw: dict


def _load_private_key(pem_source: str) -> rsa.RSAPrivateKey:
    """Accept either a filesystem path or raw PEM text."""
    if Path(pem_source).expanduser().is_file():
        data = Path(pem_source).expanduser().read_bytes()
    else:
        data = pem_source.encode("utf-8")
    key = serialization.load_pem_private_key(data, password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("Expected an RSA private key")
    return key


class KalshiClient:
    def __init__(
        self,
        key_id: str,
        private_key_pem: str,
        demo: bool = False,
        timeout: float = 10.0,
    ) -> None:
        self.key_id = key_id
        self.base_url = DEMO_BASE if demo else PROD_BASE
        self._key = _load_private_key(private_key_pem)
        self._client = httpx.AsyncClient(timeout=timeout, headers={
            "User-Agent": "OIEC-Demo/0.1 (research)",
            "Accept": "application/json",
        })

    async def close(self) -> None:
        await self._client.aclose()

    # ---- auth ----

    def _sign(self, method: str, path: str) -> dict:
        ts_ms = str(int(time.time() * 1000))
        # Strip query string — Kalshi signs path only
        path_no_query = path.split("?", 1)[0]
        if not path_no_query.startswith("/trade-api/v2"):
            raise ValueError(f"Kalshi path must start with /trade-api/v2, got {path!r}")
        message = (ts_ms + method.upper() + path_no_query).encode("utf-8")
        sig = self._key.sign(
            message,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        return {
            "KALSHI-ACCESS-KEY":       self.key_id,
            "KALSHI-ACCESS-TIMESTAMP": ts_ms,
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
        }

    # ---- requests ----

    async def _get(self, path: str, params: dict | None = None) -> dict:
        # Kalshi signs the path (no query string) that the server sees.
        # base_url includes `/trade-api/v2`, and path is `/…` after that prefix,
        # so the server-observed path is base_url's path + path.
        from urllib.parse import urlparse
        sign_path = urlparse(self.base_url + path).path
        headers = self._sign("GET", sign_path)
        r = await self._client.get(self.base_url + path, params=params, headers=headers)
        r.raise_for_status()
        return r.json()

    # ---- domain methods ----

    async def get_market(self, ticker: str) -> Optional[KalshiQuote]:
        try:
            data = await self._get(f"/markets/{ticker}")
        except httpx.HTTPError as e:
            log.warning("Kalshi get_market(%s) failed: %s", ticker, e)
            return None
        m = data.get("market") or data
        return self._parse_market(m, ticker)

    async def list_markets(
        self,
        series_ticker: Optional[str] = None,
        event_ticker: Optional[str] = None,
        status: str = "open",
        limit: int = 100,
    ) -> list[KalshiQuote]:
        params: dict = {"limit": limit, "status": status}
        if series_ticker:
            params["series_ticker"] = series_ticker
        if event_ticker:
            params["event_ticker"] = event_ticker
        try:
            data = await self._get("/markets", params=params)
        except httpx.HTTPError as e:
            log.warning("Kalshi list_markets(%s) failed: %s", series_ticker, e)
            return []
        ms = data.get("markets", [])
        quotes = []
        for m in ms:
            q = self._parse_market(m, m.get("ticker", ""))
            if q:
                quotes.append(q)
        return quotes

    async def probe_auth(self) -> bool:
        """Verify that the provided key + signing pipeline work by fetching
        an auth-required endpoint with a trivial payload."""
        try:
            # /exchange/status is lightweight and exercises auth
            await self._get("/exchange/status")
            return True
        except httpx.HTTPError as e:
            log.error("Kalshi auth probe failed: %s", e)
            return False

    @staticmethod
    def _parse_market(m: dict, ticker: str) -> Optional[KalshiQuote]:
        # Kalshi returns prices as dollar-strings like "0.6500" in newer APIs,
        # integer cents in older. Handle both.
        def _dollar_like(v) -> Optional[float]:
            if v is None:
                return None
            if isinstance(v, (int, float)):
                # heuristic: values > 1 are cents
                return float(v) / 100.0 if v > 1.5 else float(v)
            if isinstance(v, str):
                try:
                    f = float(v)
                    return f / 100.0 if f > 1.5 else f
                except ValueError:
                    return None
            return None

        yes_ask = _dollar_like(m.get("yes_ask_dollars") or m.get("yes_ask"))
        yes_bid = _dollar_like(m.get("yes_bid_dollars") or m.get("yes_bid"))
        last    = _dollar_like(m.get("last_price_dollars") or m.get("last_price"))

        # mid or last or fallback
        if yes_ask is not None and yes_bid is not None:
            yes_price = 0.5 * (yes_ask + yes_bid)
        elif last is not None:
            yes_price = last
        elif yes_ask is not None:
            yes_price = yes_ask
        else:
            return None

        vol = _dollar_like(m.get("volume") or 0) or 0.0
        title = m.get("title") or m.get("subtitle") or ticker
        return KalshiQuote(
            ticker=ticker,
            title=title,
            yes_price=max(0.001, min(0.999, yes_price)),
            yes_bid=yes_bid,
            yes_ask=yes_ask,
            volume=vol * 100.0,  # back to integer-ish units
            timestamp_s=time.time(),
            raw=m,
        )


if __name__ == "__main__":
    # Probe script — run with env vars set.
    import asyncio
    import os

    async def main():
        key_id = os.environ.get("KALSHI_KEY_ID")
        pem = os.environ.get("KALSHI_PEM_PATH", "./kalshi_private_key.pem")
        demo = os.environ.get("KALSHI_ENV", "prod").lower() == "demo"
        if not key_id:
            raise SystemExit("Set KALSHI_KEY_ID (and optionally KALSHI_PEM_PATH, KALSHI_ENV=demo|prod)")
        c = KalshiClient(key_id, pem, demo=demo)
        ok = await c.probe_auth()
        print(f"auth ok: {ok}")
        if ok:
            mkts = await c.list_markets(status="open", limit=5)
            for m in mkts:
                print(f"  {m.ticker:30s} yes={m.yes_price:.4f}  {m.title[:50]}")
        await c.close()

    asyncio.run(main())
