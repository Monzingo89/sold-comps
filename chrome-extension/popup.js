const DEFAULT_COMPS_API_BASE_URL = "https://sold-comps.onrender.com";
const OVERLAY_POSITION_KEY = "compsOverlayPosition";

const apiBaseInput = document.getElementById("apiBase");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");
const statusEl = document.getElementById("status");

init();

async function init() {
  const stored = await chrome.storage.local.get("compsApiBaseUrl");
  apiBaseInput.value = stored.compsApiBaseUrl || DEFAULT_COMPS_API_BASE_URL;
}

saveBtn.addEventListener("click", async () => {
  const value = String(apiBaseInput.value || "")
    .trim()
    .replace(/\/+$/, "");

  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Enter a full URL starting with http:// or https://";
    return;
  }

  await chrome.storage.local.set({ compsApiBaseUrl: value });
  statusEl.style.color = "#16a34a";
  statusEl.textContent = "Saved.";
});

resetBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(OVERLAY_POSITION_KEY);
  await notifyActiveTabToResetOverlay();
  statusEl.style.color = "#16a34a";
  statusEl.textContent = "Overlay position reset.";
});

async function notifyActiveTabToResetOverlay() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs?.[0]?.id;

  if (typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "RESET_OVERLAY_POSITION" });
  } catch (_error) {
    // Ignore when current tab doesn't have our content script injected.
  }
}
