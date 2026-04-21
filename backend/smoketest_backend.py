"""
End-to-end smoke test: launch the backend, open the dashboard via HTTP,
verify a WebSocket payload arrives and updates the UI.

We won't have live Polymarket/Kalshi reachable in the sandbox, but the
poller seeds synthetic data on startup, so we still get broadcasts.
"""
import subprocess
import time
import signal
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path("/home/claude/oiec-demo")
PORT = 8765

env = os.environ.copy()
env["OIEC_PORT"] = str(PORT)
env["OIEC_HOST"] = "127.0.0.1"
env["OIEC_POLL_INTERVAL"] = "2.0"   # faster for the test
env["OIEC_LOG_LEVEL"] = "WARNING"
# Leave Kalshi creds unset so it runs Polymarket-only. Polymarket will fail
# (sandbox egress blocked), but the synthetic seed still produces payloads.

proc = subprocess.Popen(
    ["python3", "main.py"],
    cwd=str(ROOT / "backend"),
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)

# Give the server a moment to come up
print("starting backend…")
time.sleep(4)
if proc.poll() is not None:
    out, _ = proc.communicate()
    print("BACKEND FAILED TO START:")
    print(out.decode(errors="replace"))
    raise SystemExit(1)

try:
    # 1) REST snapshot
    import urllib.request, json
    print("\n--- REST /status ---")
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=5) as r:
        status = json.load(r)
        print(json.dumps(status, indent=2))

    print("\n--- REST /data.json (first 500 chars) ---")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/data.json", timeout=5) as r:
            body = r.read().decode()
            print(body[:500] + "…")
    except Exception as e:
        print(f"(not ready yet: {e})")

    # 2) Browser load — confirms dashboard renders AND WS connects
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        console = []
        page.on("console", lambda m: console.append((m.type, m.text)))

        page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle", timeout=15000)
        time.sleep(5)   # wait for at least two WS ticks

        oiec = [m for t, m in console if "[OIEC]" in m]
        print("\n--- [OIEC] console lines ---")
        for m in oiec:
            print(f"  {m}")

        status_tag = page.evaluate("document.getElementById('status-tag').textContent")
        pulse_bg   = page.evaluate("getComputedStyle(document.querySelector('.nav-status .pulse')).backgroundColor")
        hero       = page.evaluate("document.getElementById('home-bignum').textContent.trim()")
        src_foot   = page.evaluate("document.getElementById('foot-src').textContent")

        print(f"\nstatus tag: {status_tag!r}")
        print(f"pulse bg:   {pulse_bg}  (green=live)")
        print(f"hero:       {hero!r}")
        print(f"footer src: {src_foot!r}")

        # Poll status again for tick count
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=5) as r:
            s2 = json.load(r)
            print(f"\nstatus after browser test: clients={s2['clients']}, tick={s2['last_tick']}, markets_live={s2['markets_live']}")

        browser.close()
finally:
    print("\nstopping backend…")
    proc.send_signal(signal.SIGINT)
    try:
        out, _ = proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
    tail = out.decode(errors="replace").splitlines()[-30:]
    print("--- backend tail ---")
    for line in tail:
        print(line)
