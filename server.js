const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

loadEnvFileIfPresent();

const DEFAULT_PORT = 8787;
const DEFAULT_SCOPE = "https://api.ebay.com/oauth/api_scope";

const ebayEnvironment = String(process.env.EBAY_ENVIRONMENT || "production").toLowerCase();
const ebayApiBase =
  ebayEnvironment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const ebayAuthBase =
  ebayEnvironment === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";

const clientId = process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID;
const clientSecret = process.env.EBAY_CLIENT_SECRET;
const oauthScope = process.env.EBAY_OAUTH_SCOPE || DEFAULT_SCOPE;
const userOAuthScope = process.env.EBAY_USER_SCOPE || oauthScope;
const ruName = String(process.env.EBAY_RUNAME || process.env.EBAY_REDIRECT_URI || "").trim();
const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN || "*";
const acceptedPath = normalizePath(
  getPathFromUrlOrPath(process.env.AUTH_ACCEPTED_URL || "/api/ebay/callback")
);
const declinedPath = normalizePath(
  getPathFromUrlOrPath(process.env.AUTH_DECLINED_URL || "/ebay/decline")
);
const connectPath = normalizePath(process.env.AUTH_START_PATH || "/api/ebay/connect");

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const tokenCache = {
  accessToken: null,
  expiresAt: 0
};

const userTokenCache = {
  accessToken: null,
  refreshToken: null,
  tokenType: null,
  scope: null,
  expiresAt: 0,
  refreshExpiresAt: 0,
  obtainedAt: 0,
  state: null
};

const pendingStates = new Map();

function loadEnvFileIfPresent() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getPathFromUrlOrPath(value) {
  try {
    return new URL(value).pathname || "/";
  } catch (_error) {
    return value;
  }
}

function normalizePath(value) {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const trimmed = withLeadingSlash.replace(/\/+$/, "");
  return trimmed || "/";
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function wantsJson(req) {
  const accept = String(req.headers.accept || "").toLowerCase();
  return accept.includes("application/json");
}

function tokenPreview(value) {
  if (!value || value.length < 12) {
    return null;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function toIsoOrNull(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function getUserTokenStatus() {
  const hasAccessToken = Boolean(userTokenCache.accessToken);
  const now = Date.now();

  return {
    hasUserToken: hasAccessToken,
    tokenType: userTokenCache.tokenType || null,
    scope: userTokenCache.scope || null,
    accessTokenPreview: tokenPreview(userTokenCache.accessToken),
    refreshTokenPreview: tokenPreview(userTokenCache.refreshToken),
    accessTokenExpiresAt: toIsoOrNull(userTokenCache.expiresAt),
    accessTokenExpired: hasAccessToken ? now >= userTokenCache.expiresAt : null,
    refreshTokenExpiresAt: toIsoOrNull(userTokenCache.refreshExpiresAt),
    obtainedAt: toIsoOrNull(userTokenCache.obtainedAt),
    state: userTokenCache.state || null
  };
}

function prunePendingStates() {
  const now = Date.now();

  for (const [state, expiresAt] of pendingStates.entries()) {
    if (expiresAt <= now) {
      pendingStates.delete(state);
    }
  }
}

function createPendingState() {
  prunePendingStates();
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  return state;
}

function consumePendingState(state) {
  if (!state) {
    return false;
  }

  prunePendingStates();
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(expiresAt && expiresAt > Date.now());
}

function buildUserConsentUrl(state) {
  if (!clientId || !ruName) {
    throw new Error("Missing EBAY_APP_ID/EBAY_CLIENT_ID or EBAY_RUNAME for user OAuth connect URL.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: "code",
    scope: userOAuthScope,
    state
  });

  return `${ebayAuthBase}/oauth2/authorize?${params.toString()}`;
}

async function exchangeAuthorizationCodeForUserToken(code, state) {
  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_APP_ID/EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in environment.");
  }

  if (!ruName) {
    throw new Error("Missing EBAY_RUNAME (required for eBay authorization_code token exchange).");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ruName
  });

  const response = await fetch(`${ebayApiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const tokenPayload = await response.json().catch(() => null);

  if (!response.ok || !tokenPayload?.access_token) {
    const detail = tokenPayload?.error_description || tokenPayload?.error || response.statusText;
    throw new Error(`Failed to exchange auth code for user token: ${detail}`);
  }

  const now = Date.now();
  const expiresIn = Number(tokenPayload.expires_in || 7200);
  const refreshExpiresIn = Number(tokenPayload.refresh_token_expires_in || 0);

  userTokenCache.accessToken = tokenPayload.access_token;
  userTokenCache.refreshToken = tokenPayload.refresh_token || null;
  userTokenCache.tokenType = tokenPayload.token_type || "User Access Token";
  userTokenCache.scope = tokenPayload.scope || userOAuthScope;
  userTokenCache.expiresAt = now + expiresIn * 1000;
  userTokenCache.refreshExpiresAt = refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : 0;
  userTokenCache.obtainedAt = now;
  userTokenCache.state = state || null;

  return getUserTokenStatus();
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function renderOAuthPage({ title, body, tone = "ok" }) {
  const border = tone === "error" ? "#dc2626" : "#2563eb";
  const heading = tone === "error" ? "#7f1d1d" : "#1e3a8a";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
      .wrap { max-width: 640px; margin: 40px auto; padding: 0 16px; }
      .card { background: #fff; border: 2px solid ${border}; border-radius: 12px; padding: 20px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }
      h1 { margin: 0 0 8px; color: ${heading}; font-size: 22px; }
      p { margin: 8px 0; line-height: 1.5; }
      .small { font-size: 13px; color: #475569; }
      code { background: #f1f5f9; border-radius: 6px; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <h1>${escapeHtml(title)}</h1>
        ${body}
      </section>
    </main>
  </body>
</html>`;
}

async function handleAcceptedCallback(req, res, url) {
  const code = String(url.searchParams.get("code") || "");
  const state = String(url.searchParams.get("state") || "");
  const error = String(url.searchParams.get("error") || "");
  const errorDescription = String(url.searchParams.get("error_description") || "");

  if (error) {
    const fallback =
      errorDescription ||
      "Authorization was declined or failed before an authorization code was returned.";

    if (wantsJson(req)) {
      sendJson(res, 400, {
        ok: false,
        accepted: false,
        error,
        errorDescription: fallback,
        declinedPath
      });
      return;
    }

    const html = renderOAuthPage({
      title: "eBay authorization not completed",
      tone: "error",
      body: `<p>${escapeHtml(fallback)}</p>
        <p class="small">If this was intentional, you can close this tab.</p>
        <p class="small">Configured decline URL: <code>${escapeHtml(declinedPath)}</code></p>`
    });
    sendHtml(res, 400, html);
    return;
  }

  if (!code) {
    if (wantsJson(req)) {
      sendJson(res, 400, {
        ok: false,
        accepted: false,
        error: "missing_code",
        message: "No authorization code found in callback query params."
      });
      return;
    }

    const html = renderOAuthPage({
      title: "Missing authorization code",
      tone: "error",
      body: "<p>No <code>code</code> query parameter was found on this callback URL.</p>"
    });
    sendHtml(res, 400, html);
    return;
  }

  if (state && !consumePendingState(state)) {
    if (wantsJson(req)) {
      sendJson(res, 400, {
        ok: false,
        accepted: false,
        error: "invalid_state",
        message: "OAuth state value is missing, expired, or invalid."
      });
      return;
    }

    const html = renderOAuthPage({
      title: "OAuth state mismatch",
      tone: "error",
      body: "<p>The OAuth state is invalid or expired. Please restart the connect flow.</p>"
    });
    sendHtml(res, 400, html);
    return;
  }

  try {
    const tokenStatus = await exchangeAuthorizationCodeForUserToken(code, state);

    if (wantsJson(req)) {
      sendJson(res, 200, {
        ok: true,
        accepted: true,
        state: state || null,
        tokenStatus,
        message: "Authorization code exchanged successfully and user token is cached."
      });
      return;
    }

    const html = renderOAuthPage({
      title: "eBay authorization connected",
      body: `<p>Your eBay account was authorized and token exchange completed successfully.</p>
        <p class="small">State: <code>${escapeHtml(state || "(none)")}</code></p>
        <p class="small">Access token expires: <code>${escapeHtml(tokenStatus.accessTokenExpiresAt || "unknown")}</code></p>
        <p class="small">You can close this tab.</p>`
    });

    sendHtml(res, 200, html);
  } catch (exchangeError) {
    const message = exchangeError?.message || "Token exchange failed.";

    if (wantsJson(req)) {
      sendJson(res, 500, {
        ok: false,
        accepted: false,
        error: "token_exchange_failed",
        message
      });
      return;
    }

    const html = renderOAuthPage({
      title: "Token exchange failed",
      tone: "error",
      body: `<p>${escapeHtml(message)}</p>
        <p class="small">Check <code>EBAY_RUNAME</code>, app credentials, and scope configuration.</p>`
    });
    sendHtml(res, 500, html);
  }
}

function handleDeclined(req, res, url) {
  const error = String(url.searchParams.get("error") || "access_denied");
  const errorDescription = String(url.searchParams.get("error_description") || "User declined eBay consent.");

  if (wantsJson(req)) {
    sendJson(res, 200, {
      ok: true,
      accepted: false,
      declined: true,
      error,
      errorDescription
    });
    return;
  }

  const html = renderOAuthPage({
    title: "eBay authorization declined",
    tone: "error",
    body: `<p>${escapeHtml(errorDescription)}</p>
      <p class="small">Error: <code>${escapeHtml(error)}</code></p>
      <p class="small">If this was accidental, start the eBay connect flow again.</p>`
  });
  sendHtml(res, 200, html);
}

async function getApplicationAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_APP_ID/EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in environment.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: oauthScope
  });

  const response = await fetch(`${ebayApiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const tokenPayload = await response.json().catch(() => null);

  if (!response.ok || !tokenPayload?.access_token) {
    const detail = tokenPayload?.error_description || tokenPayload?.error || response.statusText;
    throw new Error(`Failed to get eBay application token: ${detail}`);
  }

  const expiresIn = Number(tokenPayload.expires_in || 7200);
  tokenCache.accessToken = tokenPayload.access_token;
  tokenCache.expiresAt = now + expiresIn * 1000;

  return tokenCache.accessToken;
}

function normalizeCompsPayload(data) {
  const itemSummaries = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

  const parsedItems = itemSummaries
    .map((item) => {
      const rawPrice = item?.price?.value ?? item?.currentBidPrice?.value;
      const price = Number(rawPrice);

      if (!Number.isFinite(price)) {
        return null;
      }

      return {
        title: item?.title || "Untitled listing",
        price,
        url: item?.itemWebUrl || "https://www.ebay.com"
      };
    })
    .filter(Boolean);

  if (parsedItems.length === 0) {
    return {
      averagePrice: null,
      medianPrice: null,
      recentListings: []
    };
  }

  const prices = parsedItems.map((item) => item.price).sort((a, b) => a - b);
  const averagePrice = prices.reduce((sum, value) => sum + value, 0) / prices.length;

  const mid = Math.floor(prices.length / 2);
  const medianPrice =
    prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];

  return {
    averagePrice,
    medianPrice,
    recentListings: parsedItems
  };
}

async function getComps(query) {
  const token = await getApplicationAccessToken();

  const params = new URLSearchParams({
    q: query,
    limit: "12",
    filter: "buyingOptions:{FIXED_PRICE|AUCTION}"
  });

  const response = await fetch(`${ebayApiBase}/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = data?.errors?.[0]?.message || data?.error_description || response.statusText;
    throw new Error(`eBay Browse API error (${response.status}): ${detail}`);
  }

  return normalizeCompsPayload(data);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "sold-comps-api" });
    return;
  }

  if (url.pathname === connectPath && req.method === "GET") {
    try {
      const state = createPendingState();
      const consentUrl = buildUserConsentUrl(state);
      const requestJson = wantsJson(req) || url.searchParams.get("format") === "json";

      if (requestJson) {
        sendJson(res, 200, {
          ok: true,
          consentUrl,
          state,
          acceptedPath,
          declinedPath
        });
        return;
      }

      setCorsHeaders(res);
      res.statusCode = 302;
      res.setHeader("Location", consentUrl);
      res.end();
      return;
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error?.message || "Failed to generate eBay consent URL."
      });
      return;
    }
  }

  if (url.pathname === "/api/ebay/token-status" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      ruNameConfigured: Boolean(ruName),
      acceptedPath,
      declinedPath,
      connectPath,
      appTokenCached: Boolean(tokenCache.accessToken && Date.now() < tokenCache.expiresAt),
      userToken: getUserTokenStatus()
    });
    return;
  }

  if (url.pathname === acceptedPath && req.method === "GET") {
    await handleAcceptedCallback(req, res, url);
    return;
  }

  if ((url.pathname === declinedPath || url.pathname === "/api/ebay/decline") && req.method === "GET") {
    handleDeclined(req, res, url);
    return;
  }

  if (url.pathname === "/api/comps" && req.method === "GET") {
    const query = String(url.searchParams.get("q") || "").trim();

    if (query.length < 2) {
      sendJson(res, 400, { error: "Query parameter 'q' must be at least 2 characters." });
      return;
    }

    try {
      const comps = await getComps(query);
      sendJson(res, 200, comps);
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: error?.message || "Failed to fetch comps from eBay."
      });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found." });
});

const port = Number(process.env.PORT || DEFAULT_PORT);

server.listen(port, () => {
  console.log(`[sold-comps-api] Listening on http://localhost:${port}`);
  console.log(`[sold-comps-api] eBay environment: ${ebayEnvironment}`);
  console.log(`[sold-comps-api] connect path: ${connectPath}`);
  console.log(`[sold-comps-api] accepted callback path: ${acceptedPath}`);
  console.log(`[sold-comps-api] declined path: ${declinedPath}`);
  console.log(`[sold-comps-api] ruName configured: ${Boolean(ruName)}`);
});