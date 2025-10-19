# Pharmaceutical Marketplace

Protixa's Pharmaceutical Marketplace is a Vite + React front end paired with an Express backend designed to run on GoDaddy (Node.js hosting) while brokering orders through WooCommerce and ShipEngine.

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

### WooCommerce Integration

The backend builds a WooCommerce order payload for every checkout and will forward it when credentials are supplied.

| Variable | Description |
| --- | --- |
| `WC_STORE_URL` | Base store URL (e.g. `https://store.example.com`). |
| `WC_CONSUMER_KEY`/`WC_CONSUMER_SECRET` | REST API credentials generated in WooCommerce. |
| `WC_API_VERSION` | WooCommerce API namespace (defaults to `wc/v3`). |
| `WC_AUTO_SUBMIT_ORDERS` | When `true`, orders are pushed immediately; when `false`, payloads are logged and saved for manual submission. |

Each order response includes an `integrations.wooCommerce` object so you can confirm whether the payload was dispatched, queued, or skipped.

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
