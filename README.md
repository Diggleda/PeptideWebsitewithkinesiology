# PepPro

PepPro is a Vite + React front end paired with an Express backend designed to run on GoDaddy (Node.js hosting) while brokering orders through WooCommerce and ShipEngine.

## Project Layout

- `src/`: React client application.
- `server/`: Modular Express backend prepared for WooCommerce + ShipEngine.
- `server-data/`: File-based persistence for users and orders (easy to swap for a database later).

## Getting Started

```bash
npm install
npm run dev        # start Vite
npm run server     # start the API on http://localhost:3001
```

Running `npm run start` launches both processes in parallel for local development.

## Backend Configuration

All server configuration lives in environment variables (see `.env.example` for a full template).

```bash
cp .env.example .env
```

Key variables:

- `PORT`: API port (defaults to 3001).
- `DATA_DIR`: Where JSON storage files live (`server-data` by default).
- `JWT_SECRET`: Secret used to sign login tokens.
- `CORS_ALLOW_ORIGINS`: Comma-separated list of allowed origins (use `*` to allow all).

## Frontend Environment

Vite only exposes variables prefixed with `VITE_`. Copy `.env.example` to `.env.local` (or `.env.production`) and set:

| Variable | Description |
| --- | --- |
| `VITE_API_URL` | Base URL of the Express API (without the trailing `/api`; defaults to `http://localhost:3001`). |
| `VITE_WOO_PROXY_URL` | Optional override for the catalog proxy. Leave blank to use `${VITE_API_URL}/api/woo`. |
| `VITE_WOO_PROXY_TOKEN` | Shared secret when using a legacy PHP proxy (`token` query param). Safe to leave blank when calling the Express proxy. |

### Testing on phones/tablets (LAN)

1. Find your machine’s local IP (e.g. `10.0.0.42`) and add it to your env:
   ```bash
   # .env.local or .env
   VITE_API_URL=http://10.0.0.42:3001
   CORS_ALLOW_ORIGINS=http://localhost:3000,http://10.0.0.42:3000
   ```
2. Start the backend (it already listens on all interfaces):
   ```bash
   npm run server
   ```
3. In a second terminal run the LAN-friendly Vite script:
   ```bash
   npm run dev:lan
   ```
   This serves the app on `http://10.0.0.42:3000`.
4. Connect your phone to the same Wi‑Fi and open that URL in mobile Safari/Chrome. You’ll see live updates as you edit code.

> Tip: If you only need temporary access, you can pass `--host` once with `npm run dev -- --host 0.0.0.0`, but the `dev:lan` script makes it one command.

### WooCommerce Integration

The backend builds a WooCommerce order payload for every checkout and will forward it when credentials are supplied.

| Variable | Description |
| --- | --- |
| `WC_STORE_URL` | Base store URL (e.g. `https://store.example.com`). |
| `WC_CONSUMER_KEY`/`WC_CONSUMER_SECRET` | REST API credentials generated in WooCommerce. |
| `WC_API_VERSION` | WooCommerce API namespace (defaults to `wc/v3`). |
| `WC_AUTO_SUBMIT_ORDERS` | When `true`, orders are pushed immediately; when `false`, payloads are logged and saved for manual submission. |

Each order response includes an `integrations.wooCommerce` object so you can confirm whether the payload was dispatched, queued, or skipped.

#### Catalog Proxy Endpoints

Live product/category data now flows through the backend so no credentials ever reach the browser.

```
GET /api/woo/products              # ?per_page=48&status=publish
GET /api/woo/products/categories   # ?per_page=100
```

The proxy understands the common WooCommerce catalog query params (`per_page`, `page`, `status`, `search`, `category`, etc.) and relays responses verbatim to the frontend.

1. Generate WooCommerce REST API keys (`READ/WRITE`) inside WordPress.
2. Populate `WC_STORE_URL`, `WC_CONSUMER_KEY`, and `WC_CONSUMER_SECRET` in `.env`.
3. Start the backend (`npm run server`) and hit `GET /api/woo/products?per_page=5` to verify connectivity.
4. Point the React app at the API by setting `VITE_API_URL` accordingly (defaults to `http://localhost:3001` in development).

If you must serve the frontend from a PHP-only host, keep `VITE_WOO_PROXY_URL` pointed at your PHP script (it should accept the `token`, `endpoint`, and `q` parameters). Otherwise, leave it blank and the app automatically targets the Express proxy.

### ShipEngine Integration

ShipEngine integration prepares shipment payloads when shipping data is available.

| Variable | Description |
| --- | --- |
| `SHIPENGINE_API_KEY` | API key from ShipEngine. |
| `SHIPENGINE_ACCOUNT_ID` / `SHIPENGINE_CARRIER_ID` | Optional IDs for routing labels. |
| `SHIPENGINE_SERVICE_CODE` | Preferred carrier/service (e.g. `usps_priority_mail`). |
| `SHIPENGINE_AUTO_CREATE_LABELS` | When `true`, labels are created immediately; otherwise payloads are logged for manual submission. |
| `SHIPENGINE_SHIP_FROM_*` | Default “ship from” address details. |

If checkout does not yet collect a shipping address, the integration gracefully skips label creation and reports the reason.

## Deploying on GoDaddy

1. Upload the project files (or deploy via Git).
2. Set environment variables in the GoDaddy Hosting control panel (use `.env` template).
3. Install dependencies with `npm install`.
4. Configure the application start command to `npm run server`.
5. Use a process manager such as `pm2` (available on GoDaddy’s Node hosting) or GoDaddy's built-in service manager to keep the server running.

The Express backend exposes health and diagnostics endpoints (`/api/health`, `/api/help`) to plug into uptime monitors or GoDaddy’s health checks.

## Referral + Order Flow

- Users register/login via JWT-secured endpoints.
- Orders are stored locally with referral bonuses (5% default) computed automatically.
- Integration services fan out the order to WooCommerce and ShipEngine when credentials are set, while still returning immediate responses to the UI.

## Next Steps

- Replace the JSON file storage with a production-grade database (e.g. MySQL on GoDaddy).
- Map product IDs from the React catalog to WooCommerce product IDs/SKUs.
- Extend checkout to capture shipping details so ShipEngine labels can be generated automatically.
