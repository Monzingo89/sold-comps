const DEFAULT_COMPS_API_BASE_URL = "https://sold-comps.onrender.com";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "SEARCH_EBAY") {
    return;
  }

  (async () => {
    try {
      const apiBaseUrl = await getCompsApiBaseUrl();
      const result = await searchEbayListings(msg.title, apiBaseUrl);
      sendResponse(result);
    } catch (error) {
      sendResponse({ error: error?.message || "Unknown error while searching eBay." });
    }
  })();

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
