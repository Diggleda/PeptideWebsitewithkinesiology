## PepPro Python Backend

This directory hosts the new Flask-based backend that mirrors the capabilities
of the original Node/Express service.  The app uses a modular structure so it
can run both locally and in the production systemd/gunicorn deployment.

Key pieces:

- `config.py` – environment loading, defaults, and helper conversions.
- `logging.py` – centralised Python logging configuration.
- `storage/json_store.py` – JSON-backed persistence with optional AES-256-GCM
  encryption compatible with the previous implementation.
- `repositories/` – thin layers for working with persisted data (users, orders,
  referrals, etc.) that transparently switch between JSON files and MySQL when
  `MYSQL_ENABLED=true`.
- `services/` – business logic (authentication, orders, referrals, integrations).
- `routes/` – Flask blueprints that expose the REST API expected by the React
  frontend.
- `integrations/` – outbound connectors (WooCommerce and ShipEngine).
- `middleware/auth.py` – JWT authentication decorator.
- `wsgi.py` – WSGI entry point used by gunicorn in production.
- `database/` – MySQL connection helpers and schema bootstrap (used only when
  the MySQL backend is enabled via environment variables).

Local development flow:

1. Create a virtualenv (`python -m venv .venv`) and install dependencies from
   `requirements.txt`.
2. Copy `.env.example` to `.env` (or export the same environment variables the
   Node service used).
3. Run `flask --app python_backend.wsgi:app run --debug` (or `python -m flask`
   with the same module path) to start the backend alongside `npm run dev`.

Production runtime notes:

- The live Python backend runs under `systemd` as `peppr-api.service`.
- Production secrets must be stored manually on the server in
  `/etc/peppr-api.env`, not in repo `.env` files.
- The runtime env file should be root-managed and non-world-readable:
  `root:root` with mode `0600`.
- Production boots no longer fall back to repo `.env` files unless you
  explicitly set `DOTENV_CONFIG_PATH` to an external server-managed path.
- Do not point `DOTENV_CONFIG_PATH` at a file inside the repo in production.
- If you enable MySQL (`MYSQL_ENABLED=true`), the schema is created
  automatically on first boot, so the runtime DB user must be able to add the
  new encrypted columns and indexes.

Required production settings:

- `NODE_ENV=production`
- `JWT_SECRET=<strong random value>`
- `DATA_ENCRYPTION_KEY=<stable random value>`
- `DATA_ENCRYPTION_BLIND_INDEX_KEY=<stable random value>`
- `DATA_ENCRYPTION_KEY_VERSION=prod-v1`
- `MYSQL_SSL=true`
- `FRONTEND_BASE_URL=https://your-domain`

Optional production settings:

- `DATA_DIR=/opt/peppr/backend/server-data`
- `WOO_PRODUCT_DOC_SYNC_MODE=thread` keeps Woo product-document stub syncing in
  the web process (default)

Scheduled background jobs:

- Catalog snapshots no longer require Redis/RQ. Run them from `cron` or a
  `systemd` timer with:
  `python -m python_backend.scripts.sync_catalog_snapshot`
- Example unit files live in:
  [`ops/peppr-catalog-snapshot.service.example`](../ops/peppr-catalog-snapshot.service.example)
  and
  [`ops/peppr-catalog-snapshot.timer.example`](../ops/peppr-catalog-snapshot.timer.example).
- The product-document sync already runs on an in-process thread by default, so
  it does not need a separate queue worker unless you intentionally redesign it.

Quote PDF renderer settings:

- The export endpoint first tries the Node/Playwright renderer, then a system
  Chrome/Chromium binary, and only falls back to the plain text PDF when
  `QUOTE_PDF_ALLOW_TEXT_FALLBACK=true`.
- Set `QUOTE_PDF_NODE_BINARY` when `node` is installed outside the Python
  service PATH. On cPanel this is commonly
  `/opt/cpanel/ea-nodejs20/bin/node`.
- Set `PLAYWRIGHT_BROWSERS_PATH` when the Node renderer is present but its
  browser cache lives outside the Python service environment.
- Set `CHROMIUM_EXECUTABLE_PATH` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
  when the system browser exists in a nonstandard path.
- To inspect the current host, run
  `python3 -m python_backend.scripts.check_quote_pdf_renderer`.

See [`ops/peppr-api.env.example`](../ops/peppr-api.env.example)
for a safe non-secret template.
