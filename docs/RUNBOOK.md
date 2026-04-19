# PepPro Runbook

## Health checks

- API: `curl -fsS -u "$PEPPRO_HEALTH_BASIC_AUTH_USERNAME:$PEPPRO_HEALTH_BASIC_AUTH_PASSWORD" http://localhost:3001/api/health | jq`
- Diagnostics: `curl -fsS http://localhost:3001/api/help | jq`
- Background jobs in `thread` mode: `curl -fsS -u "$PEPPRO_HEALTH_BASIC_AUTH_USERNAME:$PEPPRO_HEALTH_BASIC_AUTH_PASSWORD" http://localhost:3001/api/health | jq '.backgroundJobs'`
- Configure the health route credentials with
  `PEPPRO_HEALTH_BASIC_AUTH_USERNAME` and `PEPPRO_HEALTH_BASIC_AUTH_PASSWORD`.

Production recommendation:

- Run the API with `systemd` + gunicorn using [`ops/peppr-api.service.example`](../ops/peppr-api.service.example).
- Run long-lived background jobs in a separate `systemd` service using [`ops/peppr-background-jobs.service.example`](../ops/peppr-background-jobs.service.example).
- Set `PEPPRO_WEB_BACKGROUND_JOBS_MODE=external` in `/etc/peppr-api.env` so gunicorn workers do not each start their own copy of the job threads.

## Bandwidth checks

- Summarize the last 15 minutes of backend traffic on the VPS:
  - `python3 python_backend/scripts/poll_bandwidth.py --since "15 minutes ago"`
- Poll it every 30 seconds while investigating a spike:
  - `watch -n 30 'python3 python_backend/scripts/poll_bandwidth.py --since "15 minutes ago"'`
- If journald access is restricted for your user, rerun with `sudo`.
- The report excludes `/api/health` and `/api/help` by default so diagnostics traffic does not skew the totals.

## Common incidents

### API is down / returning 5xx

1. Verify the process is running and listening:
   - `lsof -iTCP:3001 -sTCP:LISTEN -nP`
2. Check recent logs:
   - `journalctl -u peppr-api.service -n 200 --no-pager`
3. Restart:
   - `sudo systemctl restart peppr-api.service`
4. If requests are failing but the process is healthy, grab the `X-Request-Id` from the failing response and search logs for it.

### Background jobs are stale / not updating

1. Check the dedicated worker service:
   - `sudo systemctl status peppr-background-jobs.service --no-pager`
2. Check the dedicated worker logs:
   - `journalctl -u peppr-background-jobs.service -n 200 --no-pager`
3. Restart the worker:
   - `sudo systemctl restart peppr-background-jobs.service`
4. If you intentionally run jobs in the API process (`PEPPRO_WEB_BACKGROUND_JOBS_MODE=thread`), inspect `.backgroundJobs.unhealthyJobs` and each job’s `health`, `lastError`, `lastHeartbeatAt`, and `lifecycle`.

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
