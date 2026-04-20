# Backend Failure Modes

## Scope

This repo currently contains two backend implementations:

- `python_backend/`: the Flask backend described as the production system.
- `server/`: the older Node/Express backend still used for some local/dev paths.

This analysis treats the Python backend as the authoritative production path.

## Runtime model

Production should be split into four units:

1. `peppr-api.service`
   - gunicorn serving `python_backend.wsgi:app`
2. `peppr-presence.service`
   - gunicorn serving `python_backend.presence_wsgi:app`
   - should own `/api/settings/presence`, `/api/settings/live-clients`,
     `/api/settings/live-clients/longpoll`, `/api/settings/live-users`,
     `/api/settings/live-users/longpoll`, `/api/settings/user-activity`,
     and `/api/settings/user-activity/longpoll`
3. `peppr-background-jobs.service`
   - `python -m python_backend.background_jobs`
4. `peppr-catalog-snapshot.timer`
   - periodic catalog snapshot sync

Recommended env:

- `PEPPRO_WEB_BACKGROUND_JOBS_MODE=external`
- shared `DATA_DIR`
- `Restart=always` on both long-lived services

## Failure mode summary

### Process crash

Behavior:

- `systemd` restarts the API or background worker process.
- Background job loops also restart in-process if an individual thread exits unexpectedly.

Residual risk:

- If the whole host is unhealthy, `systemd` cannot help.

### Background thread crash

Behavior:

- `productDocumentSync`
- `shipstationStatusSync`
- `upsStatusSync`
- `presenceSweep`
- `patientLinksSweep`

are now started through `background_job_supervisor`, which restarts a loop if it returns or raises.

Residual risk:

- A hung thread cannot be force-killed safely inside Python; it must be detected as stale and the process restarted externally.

### Background thread stall / no progress

Behavior:

- `/api/health` now reports per-job `heartbeatAgeSeconds`, `staleAfterSeconds`, `lifecycle`, and `lastError`.
- Overall health becomes `degraded` when a thread-mode job is stopped or stale.

Operational response:

- when jobs run in the API process, monitor `/api/health`
- when jobs run in the dedicated worker service, monitor `systemctl status peppr-background-jobs.service` and journald
- restart the owning process when job health is degraded

Residual risk:

- `/api/health` does not directly prove the external worker service is alive; it only proves the API process is alive.

### MySQL unavailable at boot

Behavior:

- `init_database()` attempts schema/bootstrap.
- TLS enforcement errors still fail hard.
- other MySQL init failures degrade to JSON-backed storage for that process

Risk:

- this is availability-friendly, but can mask an unexpected DB outage if operators only check HTTP 200s

Mitigation:

- monitor `/api/health`
- verify `.mysql.enabled`
- monitor service logs after restart

### JSON storage corruption

Behavior:

- JSON writes are atomic.
- irrecoverably corrupted files are moved aside as `*.corrupt.<timestamp>`.
- default empty structures are served instead of repeatedly crashing the app.

Risk:

- data loss is contained, not prevented

Mitigation:

- back up `DATA_DIR`
- test restores

### Bootstrap race on storage-backed jobs

Previous risk:

- the web app started background jobs before `init_storage()`
- `presenceSweep` could run against uninitialized JSON repositories during startup

Current behavior:

- `init_storage()` now runs before background threads are started in `python_backend.create_app()`

### Integration outage (Woo, ShipStation, UPS)

Behavior:

- outbound HTTP is timeout-bounded
- sync jobs log and continue on per-run failures
- ShipStation and Woo have cooldown/circuit-breaker behavior in selected paths

Residual risk:

- repeated upstream failures can keep the job alive but ineffective

Mitigation:

- inspect per-job `lastError` in `/api/health`
- inspect journald logs

### Misconfiguration / unsafe production boot

Behavior:

- production boot fails if `JWT_SECRET` is weak/missing
- production boot fails if `DATA_ENCRYPTION_KEY` is missing
- production boot fails if `FRONTEND_BASE_URL` is not HTTPS
- production boot fails if remote MySQL is enabled without `MYSQL_SSL=true`

This is intentional fail-fast behavior.

## Operational recommendation

Use the Python backend only for production operations. Keep the Node backend as a migration/dev artifact until it is explicitly removed, but do not rely on its pm2-based operational guidance for the live system.
