# Task Board

Use this as the single source of truth for active work.

## Rules

- Keep tasks small enough to finish or verify in one session.
- Every task needs:
  - `Priority`: `P0`, `P1`, `P2`, or `P3`
  - `Status`: `todo`, `doing`, `blocked`, `verify`, or `done`
  - `Owner`: a person or role
  - `Why`: one sentence
  - `Exit`: the concrete condition that makes it done
- Move finished items to `Done Today` instead of deleting them immediately.
- If a task depends on logs, commands, or screenshots, paste the exact evidence under `Notes`.
- If something fails in production, create or update a `P0` item before debugging further.

## Active Now

### P0. Main API saturation on `peppr-api.service`

- Status: `doing`
- Owner: `Codex + operator`
- Why: users are seeing login failures, missing profile photos, and broad API slowdowns when the main API on `127.0.0.1:8000` gets worker-starved.
- Exit:
  - no fresh nginx `upstream timed out` errors for the hot routes during a real user session
  - login, quotes, news, cart, orders, and profile images all load without restart
- Notes:
  - presence traffic is already split to `peppr-presence.service`
  - April 21, 2026 browser evidence shows proxy-level failures without Flask CORS headers:
    - `502` on `https://api.peppro.net/api/referrals/dashboard?...`
    - `504` on `/api/auth/me/profile-image`
    - `504` on `/api/news/peptides?...`
  - April 21, 2026 health output was `status=ok`, but only proved one worker could answer health; it did not include in-flight stuck requests yet.
  - local code now adds `requests.activeCount`, `requests.slowCount`, and active route details to `/api/health`.
  - local code now falls back to parsed gunicorn `--workers` and live child process count when `workers.configured` / `workers.detected` would otherwise be `null`.
  - fresh failures on April 20, 2026 around `18:32-18:48 UTC` hit main API routes including:
    - `/api/woo/products/1512?force=true`
    - `/api/news/peptides`
    - `/api/auth/me/cart`
    - `/api/referrals/doctor/summary`
    - `/api/orders/on-hold`
    - `/api/settings/users/.../profile-image`

### P0. Identify the highest-cost route on the main API

- Status: `doing`
- Owner: `Codex`
- Why: cheap routes only fail after workers are already occupied; we need the blocker, not the symptom.
- Exit:
  - one route or code path is identified as the primary saturation source with evidence from code and logs
  - a mitigation task exists below it
- Notes:
  - current strongest suspect is Woo proxy work on main workers, especially `/api/woo/products/<id>?force=true` and `/api/woo/media?...`

### P1. Reduce or isolate Woo proxy load from web workers

- Status: `todo`
- Owner: `Codex`
- Why: repeated nginx timeouts continue to point at Woo-backed routes, which can block gunicorn worker threads.
- Exit:
  - either the expensive Woo path is moved off the request path or requests degrade quickly with cache/stale data instead of wedging workers
- Notes:
  - see `python_backend/routes/woo.py`
  - see `python_backend/integrations/woo_commerce.py`

### P1. Add a repeatable incident capture checklist

- Status: `done`
- Owner: `Codex`
- Why: production debugging has been happening in chat and terminal scrollback instead of one persistent place.
- Exit:
  - this file exists and current incident work is tracked here

## Next

### P1. Add a main-API triage snapshot command

- Status: `verify`
- Owner: `Codex`
- Why: each incident needs the same 5 to 8 commands and we keep retyping them.
- Exit:
  - one documented command or script captures service status, recent journald errors, and nginx upstream timeouts
- Notes:
  - added `ops/peppr-main-api-triage.sh.example`

### P1. Review gunicorn sizing against actual host limits

- Status: `todo`
- Owner: `operator`
- Why: the service currently runs four gthread workers; if the host has headroom, sizing may be too conservative for burst traffic.
- Exit:
  - memory and CPU limits are checked
  - workers/threads are either tuned or intentionally left as-is with justification

### P2. Stop frontend polling loops from amplifying outages

- Status: `doing`
- Owner: `Codex`
- Why: during outages, repeated startup fetches and retry loops make queue collapse worse.
- Exit:
  - non-essential polling and retry behavior is bounded on common failure states
- Notes:
  - live-user presence `403` loops were already reduced in `src/App.tsx`

## Parked

### P2. Move product/media fetches behind a stronger cache layer

- Status: `todo`
- Owner: `backlog`
- Why: proxying large remote assets and force-refresh catalog reads through Flask is fragile under load.
- Exit:
  - media and Woo refreshes no longer depend on synchronous request-time fetches from the main API

### P3. Migrate task board to GitHub Projects if needed

- Status: `todo`
- Owner: `backlog`
- Why: if multiple people start touching the same incident work, markdown will stop being enough.
- Exit:
  - project board mirrors the fields in this file: priority, status, owner, why, exit, notes

## Done Today

### Presence upstream split

- Status: `done`
- Owner: `Codex + operator`
- Why: long-poll presence traffic was competing with the main API.
- Exit:
  - completed
- Notes:
  - `peppr-presence.service` is live on `127.0.0.1:8001`
  - nginx routes for presence endpoints now target the dedicated upstream
  - verified from service logs on April 20, 2026 at `17:14 UTC`

### Presence polling stops on non-auth `403`

- Status: `done`
- Owner: `Codex`
- Why: access-denied presence routes were retrying and cluttering the console.
- Exit:
  - completed
- Notes:
  - fixed in `src/App.tsx`

## Intake Template

Copy this block for new work:

```md
### P?. Short task title

- Status: `todo`
- Owner: `name`
- Why: one sentence
- Exit:
  - concrete success condition
- Notes:
  - logs, commands, links, or assumptions
```
