# PepPro Runbook

## Health checks

- API: `curl -fsS http://localhost:3001/api/health | jq`
- Diagnostics: `curl -fsS http://localhost:3001/api/help | jq`

## Common incidents

### API is down / returning 5xx

1. Verify the process is running and listening:
   - `lsof -iTCP:3001 -sTCP:LISTEN -nP`
2. Check recent logs (process manager dependent):
   - `pm2 logs --lines 200`
3. Restart:
   - `pm2 restart all`
4. If requests are failing but the process is healthy, grab the `X-Request-Id` from the failing response and search logs for it.

### Repeated/duplicate checkouts

- Confirm the client is sending `Idempotency-Key` on `POST /api/orders`.
- If a provider retries requests (mobile networks), idempotency should return the original order instead of creating a new one.

### Integration failures (WooCommerce / ShipEngine / ShipStation / Stripe)

1. Confirm the integration is configured:
   - `curl -fsS http://localhost:3001/api/help | jq '.integrations'`
2. Verify the relevant environment variables are set (see `.env.example`).
3. Check backend logs for the request’s `X-Request-Id` and the integration error summary.

### Rate limiting complaints

- Adjust `RATE_LIMIT_*` env vars and restart the backend.
- If you’re behind a proxy/CDN, ensure `CF-Connecting-IP` or `X-Forwarded-For` is set so the limiter keys on the real client IP.

## Data safety

- JSON stores are written atomically and any unrecoverable corruption is moved aside as `*.corrupt.<timestamp>` under `DATA_DIR`.
- Treat `server-data/` as production data: back it up and test restores.

