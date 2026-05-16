# eBay Comps App

Recommended split layout:

```
ebay-comps-app/
├─ backend/
│  ├─ server.js
│  ├─ ebay.js
│  ├─ package.json
│  ├─ .env
│  ├─ .env.example
│  └─ .gitignore
│
└─ chrome-extension/
   ├─ manifest.json
   ├─ popup.html
   ├─ popup.js
   ├─ content.js
   ├─ background.js
   └─ styles.css
```

## Backend (`backend/`)

- `server.js` — Express API routes
- `ebay.js` — eBay token + search utilities
- `.env` — secrets and runtime config
- `package.json` — dependencies and scripts

### Backend env

Use `backend/.env`:

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_OAUTH_SCOPE=https://api.ebay.com/oauth/api_scope`
- `PORT=3000`

### Backend endpoints

- `GET /health`
- `GET /api/ebay/comps?q=ps5`

`/api/comps` is also available as an alias.

## Chrome extension (`chrome-extension/`)

- No `.env` needed in the extension folder.
- Extension calls backend only:

`https://your-backend-url.com/api/ebay/comps?q=ps5`

### Extension file roles

- `manifest.json` — extension config
- `content.js` — title/price extraction and overlay injection
- `background.js` — API call bridge
- `popup.html` + `popup.js` — configure backend base URL in extension storage
- `styles.css` — overlay styling

## Local run

1. Start backend:
   - `cd backend`
   - `npm install`
   - `npm start`
2. Load extension in Chrome:
   - open `chrome://extensions`
   - enable Developer Mode
   - click **Load unpacked**
   - select `chrome-extension/`
3. In popup, set backend URL if needed (default is `https://sold-comps.onrender.com`).

## Deploy recommendation

Recommended first deploy target: **Render**.

Current live backend:

`https://sold-comps.onrender.com`

Flow:

Marketplace page → extension reads title → calls backend → backend calls eBay → backend returns comps → extension shows overlay.
