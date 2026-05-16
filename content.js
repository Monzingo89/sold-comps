const OVERLAY_ID = "ebay-comps-overlay";

const SITE_SELECTORS = {
  "facebook.com": {
    title: ["h1", "[data-testid='marketplace_pdp_title']"],
    price: ["[data-testid='marketplace_pdp_price']", "[aria-label*='$']"]
  },
  "craigslist.org": {
    title: ["#titletextonly", "h1"],
    price: [".price", "span.price"]
  },
  "offerup.com": {
    title: ["h1", "[data-testid='listing-title']"],
    price: ["[data-testid='listing-price']", "[class*='price']"]
  },
  "amazon.com": {
    title: ["#productTitle", "h1"],
    price: [".a-price .a-offscreen", "#corePrice_feature_div .a-offscreen"]
  }
};

(async function initCompsOverlay() {
  const title = extractListingTitle();

  if (!title) {
    return;
  }

  const askingPrice = extractAskingPrice();
  renderLoading(title, askingPrice);

  const result = await searchEbay(title);

  if (!result || result.error) {
    renderError(result?.error || "No response from eBay API.", title, askingPrice);
    return;
  }

  renderComps(result, title, askingPrice);
})();

function getSelectorSet() {
  const host = window.location.hostname;

  const key = Object.keys(SITE_SELECTORS).find((domain) => host.includes(domain));
  return key ? SITE_SELECTORS[key] : { title: ["h1"], price: ["[class*='price']"] };
}

function extractListingTitle() {
  const selectors = getSelectorSet().title;

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const text = el?.textContent?.trim();

    if (text) {
      return text;
    }
  }

  return null;
}

function extractAskingPrice() {
  const selectors = getSelectorSet().price;

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const parsed = parsePrice(el?.textContent || "");

    if (typeof parsed === "number") {
      return parsed;
    }
  }

  const fallback = document.body?.innerText?.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
  return fallback ? parsePrice(fallback[0]) : null;
}

function parsePrice(text) {
  if (!text) {
    return null;
  }

  const match = String(text).replace(/\s+/g, " ").match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);

  if (!match) {
    return null;
  }

  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function searchEbay(title) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SEARCH_EBAY", title }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response);
    });
  });
}

function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "ebay-comps-overlay";
    document.body.appendChild(overlay);
  }

  return overlay;
}

function formatUsd(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function renderLoading(title, askingPrice) {
  const overlay = ensureOverlay();

  overlay.innerHTML = `
    <div class="ebay-comps-card">
      <div class="ebay-comps-header">eBay Sold Comps</div>
      <div class="ebay-comps-subtle">Searching eBay for:</div>
      <div class="ebay-comps-query">${escapeHtml(title)}</div>
      <div class="ebay-comps-subtle">Asking price: <strong>${formatUsd(askingPrice)}</strong></div>
      <div class="ebay-comps-subtle">Loading comps…</div>
    </div>
  `;
}

function renderError(message, title, askingPrice) {
  const overlay = ensureOverlay();

  overlay.innerHTML = `
    <div class="ebay-comps-card">
      <div class="ebay-comps-header">eBay Sold Comps</div>
      <div class="ebay-comps-query">${escapeHtml(title)}</div>
      <div class="ebay-comps-subtle">Asking price: <strong>${formatUsd(askingPrice)}</strong></div>
      <div class="ebay-comps-error">${escapeHtml(message)}</div>
    </div>
  `;
}

function renderComps(result, title, askingPrice) {
  const overlay = ensureOverlay();
  const estimate = typeof askingPrice === "number" ? result.averagePrice - askingPrice : null;

  const listingsHtml = result.recentListings
    .slice(0, 5)
    .map(
      (listing) => `
      <li>
        <a href="${listing.url}" target="_blank" rel="noreferrer noopener">${escapeHtml(listing.title)}</a>
        <span>${formatUsd(listing.price)}</span>
      </li>
    `
    )
    .join("");

  overlay.innerHTML = `
    <div class="ebay-comps-card">
      <div class="ebay-comps-header">eBay Sold Comps</div>
      <div class="ebay-comps-query">${escapeHtml(title)}</div>

      <div class="ebay-comps-stat-grid">
        <div>
          <div class="ebay-comps-label">Avg eBay</div>
          <div class="ebay-comps-value">${formatUsd(result.averagePrice)}</div>
        </div>
        <div>
          <div class="ebay-comps-label">Median</div>
          <div class="ebay-comps-value">${formatUsd(result.medianPrice)}</div>
        </div>
      </div>

      <div class="ebay-comps-subtle">Asking price: <strong>${formatUsd(askingPrice)}</strong></div>
      <div class="ebay-comps-subtle">Resale estimate: <strong>${formatUsd(estimate)}</strong></div>

      <div class="ebay-comps-subtle">Recent comparable listings</div>
      <ul class="ebay-comps-list">${listingsHtml || "<li>No comparable listings found.</li>"}</ul>
    </div>
  `;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
