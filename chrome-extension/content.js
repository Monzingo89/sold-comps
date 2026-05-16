const OVERLAY_ID = "ebay-comps-overlay";
const REFRESH_DEBOUNCE_MS = 450;
const OVERLAY_POSITION_KEY = "compsOverlayPosition";
const OVERLAY_MARGIN = 8;
const AMAZON_PRODUCT_PATH_REGEX = /\/(dp|gp\/product|gp\/aw\/d)\//i;
const FACEBOOK_MARKETPLACE_ITEM_PATH_REGEX = /\/marketplace\/item\//i;
const FACEBOOK_GENERIC_TITLE_REGEX =
  /^(marketplace|facebook marketplace|top picks|today'?s picks|items for you|for you)$/i;

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

let refreshTimerId = null;
let lastContextKey = "";
let lastKnownUrl = window.location.href;
let requestSequence = 0;
let hasRenderedOverlayBefore = false;
let overlayPositionRestored = false;
let activeDrag = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "RESET_OVERLAY_POSITION") {
    return false;
  }

  resetOverlayPosition();
  sendResponse({ ok: true });
  return false;
});

initCompsOverlay();

function initCompsOverlay() {
  startAutoRefreshWatchers();
  runOverlaySearch({ force: true });
}

function startAutoRefreshWatchers() {
  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");

  window.addEventListener("popstate", () => {
    onRoutePotentiallyChanged();
    scheduleOverlayRefresh();
  });

  window.addEventListener("hashchange", () => {
    onRoutePotentiallyChanged();
    scheduleOverlayRefresh();
  });

  const observer = new MutationObserver(() => {
    onRoutePotentiallyChanged();
    scheduleOverlayRefresh();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function wrapHistoryMethod(methodName) {
  const original = window.history?.[methodName];

  if (typeof original !== "function") {
    return;
  }

  window.history[methodName] = function patchedHistoryMethod(...args) {
    const result = original.apply(this, args);
    onRoutePotentiallyChanged();
    scheduleOverlayRefresh();
    return result;
  };
}

function onRoutePotentiallyChanged() {
  if (window.location.href !== lastKnownUrl) {
    lastKnownUrl = window.location.href;
  }
}

function scheduleOverlayRefresh() {
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
  }

  refreshTimerId = setTimeout(() => {
    refreshTimerId = null;
    runOverlaySearch();
  }, REFRESH_DEBOUNCE_MS);
}

function getContextKey(title) {
  return `${window.location.href}::${String(title || "").trim()}`;
}

async function runOverlaySearch({ force = false } = {}) {
  try {
    let title;
    let askingPrice;

    if (isFacebookHost()) {
      const context = getFacebookListingContext();
      title = context.title;
      askingPrice = context.price;
    } else {
      title = extractListingTitle();
      askingPrice = extractAskingPrice();
    }

    if (!title) {
      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay) {
        overlay.remove();
      }
      lastContextKey = "";
      hasRenderedOverlayBefore = false;
      return;
    }

    const contextKey = getContextKey(title);

    if (!force && contextKey === lastContextKey) {
      return;
    }

    lastContextKey = contextKey;

    const isRefreshing = hasRenderedOverlayBefore;
    renderLoading(title, askingPrice, isRefreshing);
    hasRenderedOverlayBefore = true;

    const runId = ++requestSequence;

    const result = await searchEbay(title);

    if (runId !== requestSequence) {
      return;
    }

    if (!result || result.error) {
      renderError(result?.error || "No response from eBay API.", title, askingPrice);
      return;
    }

    renderComps(result, title, askingPrice);
  } catch (error) {
    const overlay = ensureOverlay();
    overlay.innerHTML = `
      <div class="ebay-comps-card">
        <div class="ebay-comps-header-row">
          <div class="ebay-comps-header">eBay Sold Comps</div>
        </div>
        <div class="ebay-comps-error">${escapeHtml(error?.message || "Unexpected extension error.")}</div>
      </div>
    `;
  }
}

function getSelectorSet() {
  const host = window.location.hostname;

  const key = Object.keys(SITE_SELECTORS).find((domain) => host.includes(domain));
  return key ? SITE_SELECTORS[key] : { title: ["h1"], price: ["[class*='price']"] };
}

function isAmazonHost() {
  return window.location.hostname.includes("amazon.com");
}

function isAmazonProductPage() {
  return isAmazonHost() && AMAZON_PRODUCT_PATH_REGEX.test(window.location.pathname);
}

function isFacebookHost() {
  return window.location.hostname.includes("facebook.com");
}

function isFacebookMarketplaceItemPage() {
  return isFacebookHost() && FACEBOOK_MARKETPLACE_ITEM_PATH_REGEX.test(window.location.pathname);
}

function extractListingTitle() {
  if (isAmazonHost()) {
    if (!isAmazonProductPage()) {
      return null;
    }

    const amazonTitle = extractAmazonTitle();
    return amazonTitle;
  }

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

function isUsableFacebookTitle(title) {
  const normalized = String(title || "").replace(/\s+/g, " ").trim();

  if (!normalized || normalized.length < 5) {
    return false;
  }

  return !FACEBOOK_GENERIC_TITLE_REGEX.test(normalized);
}

function extractPriceFromText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  if (/ships?\s+for|delivery|estimated\s+arrival|watchers?/i.test(normalized)) {
    return null;
  }

  const parsed = parsePrice(text || "");
  return typeof parsed === "number" && parsed > 0 && parsed < 200000 ? parsed : null;
}

function isElementVisiblyRendered(element) {
  if (!element) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  if (element.getAttribute("aria-hidden") === "true") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findFacebookPriceNearElement(titleElement) {
  const titleHeader = titleElement.closest("h1") || titleElement;

  // First, try immediate sibling blocks under the title header (where main price usually lives).
  let sibling = titleHeader.nextElementSibling;
  for (let i = 0; sibling && i < 3; i += 1) {
    const parsed = extractPriceFromText(sibling.textContent || "");
    if (typeof parsed === "number") {
      return parsed;
    }
    sibling = sibling.nextElementSibling;
  }

  // Then search nearby containers for explicit marketplace price markers.
  const selectors = [
    "[data-testid='marketplace_pdp_price']",
    "div[aria-hidden='false'] span[dir='auto']",
    "[aria-label*='$']"
  ];

  let container = titleElement.closest("div");
  for (let depth = 0; container && depth < 4; depth += 1) {
    for (const selector of selectors) {
      const nodes = container.querySelectorAll(selector);
      for (const node of nodes) {
        if (!isElementVisiblyRendered(node)) {
          continue;
        }

        const parsed = extractPriceFromText(node.textContent || "");
        if (typeof parsed === "number") {
          return parsed;
        }
      }
    }

    container = container.parentElement;
  }

  return null;
}

function getFacebookListingContext() {
  if (!isFacebookMarketplaceItemPage()) {
    return { title: null, price: null };
  }

  const selectors = [
    "[data-testid='marketplace_pdp_title']",
    "h1[aria-hidden='false'] span[dir='auto']",
    "div[role='main'] h1 span[dir='auto']",
    "div[role='main'] h1",
    "h1"
  ];
  const seen = new Set();
  const candidates = [];

  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (seen.has(node)) {
        continue;
      }
      seen.add(node);
      candidates.push(node);
    }
  }

  let best = null;

  for (const node of candidates) {
    if (!isElementVisiblyRendered(node)) {
      continue;
    }

    const title = String(node.textContent || "").replace(/\s+/g, " ").trim();

    if (!isUsableFacebookTitle(title)) {
      continue;
    }

    const price = findFacebookPriceNearElement(node);
    const header = node.closest("h1") || node;
    const rect = header.getBoundingClientRect();
    const topBias = rect.top >= 0 ? Math.max(0, 600 - rect.top) / 600 : 0;
    const score =
      (node.matches("[data-testid='marketplace_pdp_title']") ? 5 : 0) +
      (node.matches("h1[aria-hidden='false'] span[dir='auto']") ? 4 : 0) +
      (node.closest("div[role='main']") ? 2 : 0) +
      (typeof price === "number" ? 3 : 0) +
      topBias +
      Math.min(title.length, 120) / 120;

    if (!best || score > best.score) {
      best = { title, price, score };
    }
  }

  if (!best) {
    return { title: null, price: null };
  }

  return {
    title: best.title,
    price: typeof best.price === "number" ? best.price : null
  };
}

function extractAmazonTitle() {
  const selectors = ["#productTitle", "#title h1", "#titleSection h1"];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const text = el?.textContent?.trim();

    if (text && !/you may also like/i.test(text)) {
      return text;
    }
  }

  return null;
}

function extractAskingPrice() {
  if (isFacebookHost()) {
    // Facebook price is extracted together with title context to avoid picking shipping/recommendation values.
    return null;
  }

  if (isAmazonHost()) {
    return extractAmazonAskingPrice();
  }

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

function extractAmazonAskingPrice() {
  if (!isAmazonProductPage()) {
    return null;
  }

  const selectors = [
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
    "#corePrice_feature_div .a-price .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-offscreen",
    "#corePrice_feature_div .a-offscreen",
    "#price_inside_buybox",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    "#priceblock_saleprice"
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const parsed = parsePrice(el?.textContent || "");

    if (typeof parsed === "number") {
      return parsed;
    }
  }

  // Intentionally no broad body-text fallback on Amazon,
  // to avoid pulling recommendation/ad prices.
  return null;
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
    let settled = false;

    const settle = (payload) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(payload);
    };

    const timeoutId = setTimeout(() => {
      settle({
        error:
          "Timed out waiting for extension background response. Reload the extension and try again."
      });
    }, 16000);

    try {
      chrome.runtime.sendMessage({ type: "SEARCH_EBAY", title }, (response) => {
        clearTimeout(timeoutId);

        if (chrome.runtime.lastError) {
          settle({ error: chrome.runtime.lastError.message });
          return;
        }

        settle(response || { error: "No response from extension background." });
      });
    } catch (error) {
      clearTimeout(timeoutId);
      settle({ error: error?.message || "Failed to send message to extension background." });
    }
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

  initializeOverlayInteractions(overlay);
  restoreOverlayPosition(overlay);

  return overlay;
}

function initializeOverlayInteractions(overlay) {
  if (overlay.dataset.dragInitialized === "1") {
    return;
  }

  overlay.dataset.dragInitialized = "1";

  overlay.addEventListener("pointerdown", (event) => {
    const headerRow = event.target?.closest?.(".ebay-comps-header-row");

    if (!headerRow) {
      return;
    }

    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }

    const rect = overlay.getBoundingClientRect();

    activeDrag = {
      overlay,
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height
    };

    overlay.classList.add("ebay-comps-dragging");
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event) => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) {
      return;
    }

    const maxLeft = Math.max(OVERLAY_MARGIN, window.innerWidth - activeDrag.width - OVERLAY_MARGIN);
    const maxTop = Math.max(OVERLAY_MARGIN, window.innerHeight - activeDrag.height - OVERLAY_MARGIN);

    const left = clamp(event.clientX - activeDrag.offsetX, OVERLAY_MARGIN, maxLeft);
    const top = clamp(event.clientY - activeDrag.offsetY, OVERLAY_MARGIN, maxTop);

    applyOverlayPosition(activeDrag.overlay, left, top);
  });

  const endDrag = (event) => {
    if (!activeDrag) {
      return;
    }

    if (event && event.pointerId !== undefined && event.pointerId !== activeDrag.pointerId) {
      return;
    }

    const overlayRef = activeDrag.overlay;
    activeDrag = null;
    overlayRef.classList.remove("ebay-comps-dragging");
    persistOverlayPosition(overlayRef);
  };

  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => {
    clampOverlayToViewport(overlay, false);
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function applyOverlayPosition(overlay, left, top) {
  overlay.style.left = `${Math.round(left)}px`;
  overlay.style.top = `${Math.round(top)}px`;
  overlay.style.right = "auto";
  overlay.style.bottom = "auto";
}

function clampOverlayToViewport(overlay, saveAfterClamp) {
  const rect = overlay.getBoundingClientRect();

  const maxLeft = Math.max(OVERLAY_MARGIN, window.innerWidth - rect.width - OVERLAY_MARGIN);
  const maxTop = Math.max(OVERLAY_MARGIN, window.innerHeight - rect.height - OVERLAY_MARGIN);

  const left = clamp(rect.left, OVERLAY_MARGIN, maxLeft);
  const top = clamp(rect.top, OVERLAY_MARGIN, maxTop);

  if (Math.abs(left - rect.left) > 0.5 || Math.abs(top - rect.top) > 0.5) {
    applyOverlayPosition(overlay, left, top);

    if (saveAfterClamp) {
      persistOverlayPosition(overlay);
    }
  }
}

function restoreOverlayPosition(overlay) {
  if (overlayPositionRestored) {
    return;
  }

  overlayPositionRestored = true;

  try {
    chrome.storage.local.get(OVERLAY_POSITION_KEY, (stored) => {
      if (chrome.runtime.lastError) {
        return;
      }

      const position = stored?.[OVERLAY_POSITION_KEY];
      const hasValidLeft = Number.isFinite(position?.left);
      const hasValidTop = Number.isFinite(position?.top);

      if (!hasValidLeft || !hasValidTop) {
        return;
      }

      applyOverlayPosition(overlay, position.left, position.top);
      clampOverlayToViewport(overlay, false);
    });
  } catch (_error) {
    // Ignore storage read failures; overlay remains at default position.
  }
}

function persistOverlayPosition(overlay) {
  const rect = overlay.getBoundingClientRect();

  try {
    chrome.storage.local.set({
      [OVERLAY_POSITION_KEY]: {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }
    });
  } catch (_error) {
    // Ignore storage write failures.
  }
}

function resetOverlayPosition() {
  const overlay = document.getElementById(OVERLAY_ID);

  if (!overlay) {
    return;
  }

  activeDrag = null;
  overlay.classList.remove("ebay-comps-dragging");
  overlay.style.left = "";
  overlay.style.top = "";
  overlay.style.right = "";
  overlay.style.bottom = "";
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

function renderLoading(title, askingPrice, isRefreshing = false) {
  const overlay = ensureOverlay();
  const badgeHtml = isRefreshing
    ? '<span class="ebay-comps-refresh-badge">Refreshing…</span>'
    : "";

  overlay.innerHTML = `
    <div class="ebay-comps-card">
      <div class="ebay-comps-header-row">
        <div class="ebay-comps-header">eBay Sold Comps</div>
        ${badgeHtml}
      </div>
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
      <div class="ebay-comps-header-row">
        <div class="ebay-comps-header">eBay Sold Comps</div>
      </div>
      <div class="ebay-comps-query">${escapeHtml(title)}</div>
      <div class="ebay-comps-subtle">Asking price: <strong>${formatUsd(askingPrice)}</strong></div>
      <div class="ebay-comps-error">${escapeHtml(message)}</div>
    </div>
  `;
}

function renderComps(result, title, askingPrice) {
  const overlay = ensureOverlay();
  const estimate = typeof askingPrice === "number" ? result.averagePrice - askingPrice : null;

  const listingsHtml = (result.recentListings || [])
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
      <div class="ebay-comps-header-row">
        <div class="ebay-comps-header">eBay Sold Comps</div>
      </div>
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
