const DEFAULT_SCOPE = "https://api.ebay.com/oauth/api_scope";
const DEFAULT_MARKETPLACE_ID = "EBAY_US";

const ebayEnvironment = String(process.env.EBAY_ENVIRONMENT || "production").toLowerCase();
const ebayApiBase =
  ebayEnvironment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

const clientId = process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID;
const clientSecret = process.env.EBAY_CLIENT_SECRET;
const oauthScope = process.env.EBAY_OAUTH_SCOPE || DEFAULT_SCOPE;
const marketplaceId = process.env.EBAY_MARKETPLACE_ID || DEFAULT_MARKETPLACE_ID;

const tokenCache = {
  accessToken: null,
  expiresAt: 0
};

async function getEbayToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_CLIENT_ID (or EBAY_APP_ID) or EBAY_CLIENT_SECRET.");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${ebayApiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: oauthScope
    })
  });

  const payload = await res.json().catch(() => null);

  if (!res.ok || !payload?.access_token) {
    const detail = payload?.error_description || payload?.error || res.statusText;
    throw new Error(`Failed to get app token: ${detail}`);
  }

  const expiresIn = Number(payload.expires_in || 7200);
  tokenCache.accessToken = payload.access_token;
  tokenCache.expiresAt = now + expiresIn * 1000;

  return tokenCache.accessToken;
}

async function searchEbay(query) {
  const token = await getEbayToken();

  const params = new URLSearchParams({
    q: query,
    limit: "10"
  });

  const res = await fetch(`${ebayApiBase}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId
    }
  });

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = payload?.errors?.[0]?.message || payload?.error_description || res.statusText;
    throw new Error(`eBay search failed (${res.status}): ${detail}`);
  }

  return payload;
}

function normalizeCompsPayload(data, query) {
  const items = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

  const prices = items
    .map((item) => Number(item?.price?.value))
    .filter((price) => Number.isFinite(price));

  const averagePrice =
    prices.length > 0 ? prices.reduce((sum, price) => sum + price, 0) / prices.length : null;

  const sortedPrices = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sortedPrices.length / 2);
  const medianPrice =
    sortedPrices.length === 0
      ? null
      : sortedPrices.length % 2 === 0
        ? (sortedPrices[mid - 1] + sortedPrices[mid]) / 2
        : sortedPrices[mid];

  const recentListings = items
    .map((item) => {
      const price = Number(item?.price?.value);

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

  return {
    query,
    averagePrice,
    medianPrice,
    count: prices.length,
    items,
    recentListings
  };
}

async function getCompsForQuery(query) {
  const data = await searchEbay(query);
  return normalizeCompsPayload(data, query);
}

module.exports = {
  getEbayToken,
  searchEbay,
  getCompsForQuery
};
