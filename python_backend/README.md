## PepPro Python Backend

This directory hosts the new Flask-based backend that mirrors the capabilities
of the original Node/Express service.  The app uses a modular structure so it
can run both locally and inside cPanel's “Setup Python App” environment.

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
- `wsgi.py` – entry point used by Passenger/mod_wsgi on cPanel.
- `database/` – MySQL connection helpers and schema bootstrap (used only when
  the MySQL backend is enabled via environment variables).

Local development flow:

1. Create a virtualenv (`python -m venv .venv`) and install dependencies from
   `requirements.txt`.
2. Copy `.env.example` to `.env` (or export the same environment variables the
   Node service used).
3. Run `flask --app python_backend.wsgi:app run --debug` (or `python -m flask`
   with the same module path) to start the backend alongside `npm run dev`.

When deploying to cPanel, set the application entry point to
`python_backend/wsgi.py` and make sure the `WORKING_DIRECTORY` points to the
project root. If you enable MySQL (`MYSQL_ENABLED=true`), provide the GoDaddy
database credentials in the environment variables; the schema is created
automatically on first boot.
