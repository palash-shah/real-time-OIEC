"""
Embed data.json into index.html (into the <script id="oiec-embed"> block)
and emit a data.js sidecar. Run after regenerating data.json.

The HTML contains a placeholder:
    <script type="application/json" id="oiec-embed">{"markets":[]}</script>
We replace its contents (ONLY the contents) with the JSON payload.
"""

import json
import re
from pathlib import Path

root = Path(__file__).parent
html_path = root / "index.html"
json_path = root / "data.json"
js_path   = root / "data.js"

data = json.loads(json_path.read_text())
payload_min = json.dumps(data, separators=(",", ":"))

html = html_path.read_text()

pattern = re.compile(
    r'(<script type="application/json" id="oiec-embed">)(.*?)(</script>)',
    flags=re.DOTALL,
)
if not pattern.search(html):
    raise SystemExit("ERROR: could not find <script id='oiec-embed'> placeholder in index.html")

# Use a lambda so JSON backslashes (\u0302 etc.) are not treated as regex backrefs
new_html, n = pattern.subn(
    lambda m: m.group(1) + payload_min + m.group(3),
    html,
    count=1,
)
assert n == 1, f"expected 1 replacement, made {n}"
html_path.write_text(new_html)

js_path.write_text(
    "// Auto-generated from data.json. Regenerate via embed_data.py\n"
    "// after any change to data.json.\n"
    "window.OIEC_DATA = "
    + json.dumps(data, indent=2)
    + ";\n"
)

print(f"HTML: embedded block updated ({len(payload_min):,} chars minified)")
print(f"JS:   {js_path.name} written ({js_path.stat().st_size:,} bytes)")
print(f"markets in payload: {len(data['markets'])}")
