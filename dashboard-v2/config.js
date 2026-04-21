/* ============================================================
   OIEC dashboard configuration
   Edit this one line to point the dashboard at your backend.
   ============================================================ */

window.OIEC_CONFIG = {
  // Your backend URL. For Render: "https://<your-service>.onrender.com"
  // Leave empty string "" to use same-origin (useful when backend serves the dashboard).
  backend_url: "",

  // How long to wait before declaring the WebSocket "stale" (no ticks arriving).
  stale_ms: 15000,
};
