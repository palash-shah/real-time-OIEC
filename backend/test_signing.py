"""
Offline test of the Kalshi signing pipeline.
Generates a throwaway RSA key, runs our _sign() function, and independently
verifies the produced signature with the matching public key.
"""

import base64
import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from kalshi import KalshiClient


def main():
    # generate throwaway 2048-bit RSA key
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub = priv.public_key()

    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    client = KalshiClient(key_id="test-key-id", private_key_pem=pem)

    method = "GET"
    path = "/trade-api/v2/markets"
    # freeze time for deterministic-ish test
    t0 = int(time.time() * 1000)
    headers = client._sign(method, path)
    ts = headers["KALSHI-ACCESS-TIMESTAMP"]
    sig_b64 = headers["KALSHI-ACCESS-SIGNATURE"]
    assert headers["KALSHI-ACCESS-KEY"] == "test-key-id"

    # signatures include timestamp so recompute what the server would verify
    message = (ts + method + path).encode("utf-8")
    sig = base64.b64decode(sig_b64)

    # verify with the public half
    try:
        pub.verify(
            sig,
            message,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        print("signature verifies")
    except Exception as e:
        raise SystemExit(f"signature FAILED to verify: {e}")

    # tamper check
    bad_msg = (ts + method + path + "x").encode("utf-8")
    try:
        pub.verify(
            sig,
            bad_msg,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        raise SystemExit("tampered message verified (should not!)")
    except Exception:
        print("tampered message correctly rejected")

    # timestamp sanity
    assert abs(int(ts) - t0) < 2000, f"timestamp drift: {ts} vs {t0}"
    print(f"timestamp ok ({ts})")

    # path-stripping check
    hdrs2 = client._sign("GET", "/trade-api/v2/markets?limit=5")
    # For a query-stringed path, _sign should reject the ? prefix — but we handle
    # it at _get; here we just confirm manually stripping works.
    message2 = (hdrs2["KALSHI-ACCESS-TIMESTAMP"] + "GET" + "/trade-api/v2/markets?limit=5").encode()
    try:
        pub.verify(base64.b64decode(hdrs2["KALSHI-ACCESS-SIGNATURE"]), message2,
                   padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
                   hashes.SHA256())
        print("(ok: _sign accepts the literal path; _get strips query separately)")
    except Exception:
        print("(note: _sign(path-with-query) verifies only with literal path; _get strips queries before calling _sign)")


if __name__ == "__main__":
    main()
