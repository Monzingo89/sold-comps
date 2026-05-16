require("dotenv").config();

const express = require("express");
const { getCompsForQuery } = require("./ebay");

const app = express();

const port = Number(process.env.PORT || 3000);
const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN || "*";
const host = process.env.HOST || "0.0.0.0";
const publicBaseUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || null;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sold-comps-api" });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "sold-comps-api",
    message: "API is running. Use /api/ebay/comps?q=<search>",
    endpoints: ["/health", "/api/ebay/comps?q=ps5", "/api/comps?q=ps5"]
  });
});

async function handleCompsRoute(req, res) {
  const query = String(req.query.q || "").trim();

  if (query.length < 2) {
    res.status(400).json({ error: "Query parameter 'q' must be at least 2 characters." });
    return;
  }

  try {
    const comps = await getCompsForQuery(query);
    res.json(comps);
  } catch (error) {
    res.status(500).json({ error: error?.message || "Failed to fetch comps from eBay." });
  }
}

app.get("/api/ebay/comps", handleCompsRoute);
app.get("/api/comps", handleCompsRoute);

app.listen(port, host, () => {
  console.log(`[sold-comps-api] Listening on http://${host}:${port} (internal)`);

  if (publicBaseUrl) {
    const normalized = String(publicBaseUrl).replace(/\/+$/, "");
    console.log(`[sold-comps-api] Public URL: ${normalized}`);
    console.log(`[sold-comps-api] comps endpoint: ${normalized}/api/ebay/comps`);
  } else {
    console.log("[sold-comps-api] comps endpoint: /api/ebay/comps");
  }
});
