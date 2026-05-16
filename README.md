# eBay Sold Comps (MVP)

A Chrome extension that overlays eBay comps on listing pages.

This version uses a **backend API** for eBay calls, so secrets stay server-side.

## What it does

- Extracts listing title from:
  - Facebook Marketplace
  - Craigslist
  - OfferUp
  - Amazon product pages
- Calls your backend `/api/comps`, which:
  - gets/caches an eBay **Application Access Token** (`client_credentials` flow)
  - calls eBay Browse API
  - returns normalized comps data
- Shows overlay with:
  - Average eBay price
  - Median price
  - Recent comparable listings
  - Resale estimate (if asking price is detectable on page)

## Architecture

`Chrome extension -> your backend -> eBay API`

No eBay secrets or tokens are stored in extension code.

## Quick setup

1. Create an eBay developer app at `developer.ebay.com`.
2. Copy `.env.example` to `.env` and set:
   - `EBAY_APP_ID`
   - `EBAY_CLIENT_SECRET`
   - `EBAY_RUNAME` (exact RuName from eBay redirect settings)
   - optional `EBAY_USER_SCOPE` for user-login permissions
   - optionally `EBAY_ENVIRONMENT=sandbox` for sandbox testing
3. Start backend API:
   - `npm start`
4. Load extension:
   - Open `chrome://extensions`
   - Enable Developer Mode
   - Click **Load unpacked** and select this folder
5. (Optional) set a non-local backend URL in extension storage:
   - `chrome.storage.local.set({ compsApiBaseUrl: "https://virtualcommercecards.com" })`
6. Visit a supported listing page and the overlay will appear.

## API endpoints

- `GET /health` -> service health check
- `GET /api/comps?q=<search text>` -> normalized comps payload
- `GET /api/ebay/connect` -> starts user OAuth (302 redirect), or `?format=json` for consent URL payload
- `GET /api/ebay/callback` -> accepted OAuth callback handler; exchanges `code` for user tokens
- `GET /ebay/decline` -> declined OAuth handler (returns HTML or JSON)
- `GET /api/ebay/decline` -> JSON/API alias for declined flow
- `GET /api/ebay/token-status` -> current in-memory user token status (masked)

### OAuth callback notes

- Configure eBay redirect URLs to:
   - accepted: `https://virtualcommercecards.com/api/ebay/callback`
   - declined: `https://virtualcommercecards.com/ebay/decline`
- `EBAY_RUNAME` must match the eBay redirect entry exactly.
- User tokens are currently cached in memory for development (not persisted to a database yet).

## Files

- `manifest.json` — Extension config, permissions, content/background wiring
- `content.js` — Title extraction + overlay UI injection
- `background.js` — Extension message handling + backend API call
- `styles.css` — Overlay styling
- `server.js` — Backend app-token + eBay Browse proxy
- `.env.example` — Safe env template

## Notes

- This MVP uses eBay Browse API listing comps.
- For user-specific eBay features (orders, seller inventory, messages), add full user OAuth later.
