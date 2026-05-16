const DEFAULT_COMPS_API_BASE_URL = "https://sold-comps.onrender.com";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "SEARCH_EBAY") {
    return false;
  }

  let responded = false;

  const safeSendResponse = (payload) => {
    if (responded) {
      return;
    }

    responded = true;

    try {
      sendResponse(payload);
    } catch (_error) {
      // Channel may be closed; ignore because caller has its own timeout fallback.
    }
  };

  (async () => {
    try {
      const apiBaseUrl = await getCompsApiBaseUrl();
      const result = await searchEbayListings(msg.title, apiBaseUrl);
      safeSendResponse(result);
    } catch (error) {
      safeSendResponse({ error: error?.message || "Unknown error while searching eBay." });
    }
  })();

  setTimeout(() => {
    safeSendResponse({
      error: "Comps request timed out. Please try again."
    });
  }, 15000);

  return true;
});

async function getCompsApiBaseUrl() {
  const stored = await chrome.storage.local.get("compsApiBaseUrl");
  const configured = String(stored.compsApiBaseUrl || DEFAULT_COMPS_API_BASE_URL)
    .trim()
    .replace(/\/+$/, "");

  return configured || DEFAULT_COMPS_API_BASE_URL;
}

async function searchEbayListings(query, apiBaseUrl) {
  const params = new URLSearchParams({ q: query });
  const url = `${apiBaseUrl}/api/ebay/comps?${params.toString()}`;

  let response;

  try {
    response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (_error) {
    throw new Error(
      `Could not reach comps API at ${apiBaseUrl}. Start your backend or set the API base URL in the popup.`
    );
  }

  let data;

  try {
    data = await response.json();
  } catch (_error) {
    throw new Error("Comps API returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(data?.error || `Comps API request failed: ${response.status}`);
  }

  return data;
}
