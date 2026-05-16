const DEFAULT_COMPS_API_BASE_URL = "https://sold-comps.onrender.com";

const apiBaseInput = document.getElementById("apiBase");
const saveBtn = document.getElementById("saveBtn");
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
