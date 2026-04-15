# VPS Manual Secrets Runbook

PepPro production secrets are stored manually on the VPS in
`/etc/peppr-api.env` and loaded by `peppr-api.service`.

## Create the runtime env file

```bash
sudo install -o root -g root -m 600 /dev/null /etc/peppr-api.env
sudoedit /etc/peppr-api.env
```

Populate it from
[`ops/peppr-api.env.example`](../ops/peppr-api.env.example)
using real production values.

Generate the long-lived crypto keys once per environment:

```bash
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 48
```

Use them for:

- `DATA_ENCRYPTION_KEY`
- `DATA_ENCRYPTION_BLIND_INDEX_KEY`
- `JWT_SECRET`

Do not rotate `DATA_ENCRYPTION_KEY` or `DATA_ENCRYPTION_BLIND_INDEX_KEY`
without a dedicated data re-encryption migration.

## Verify systemd uses the server env file

```bash
systemctl cat peppr-api.service
sudo egrep '^(NODE_ENV|PORT|DATA_DIR|JWT_SECRET|DATA_ENCRYPTION_|MYSQL_|FRONTEND_BASE_URL|WOO_PRODUCT_DOC_SYNC_MODE)=' /etc/peppr-api.env
```

The service should load `/etc/peppr-api.env` via `EnvironmentFile=`.

## Restart and verify

```bash
sudo systemctl daemon-reload
sudo systemctl restart peppr-api.service
sudo systemctl status peppr-api.service --no-pager
journalctl -u peppr-api.service -n 100 --no-pager
```

## Install the catalog snapshot timer

Use the example units in
[`ops/peppr-catalog-snapshot.service.example`](../ops/peppr-catalog-snapshot.service.example)
and
[`ops/peppr-catalog-snapshot.timer.example`](../ops/peppr-catalog-snapshot.timer.example),
then install them on the VPS:

```bash
sudo cp ops/peppr-catalog-snapshot.service.example /etc/systemd/system/peppr-catalog-snapshot.service
sudo cp ops/peppr-catalog-snapshot.timer.example /etc/systemd/system/peppr-catalog-snapshot.timer
sudo systemctl daemon-reload
sudo systemctl enable --now peppr-catalog-snapshot.timer
sudo systemctl list-timers --all | grep peppr-catalog-snapshot
```

## Expected production behavior

- The backend does not auto-load repo `.env` files in production.
- New PHI-bearing writes use encrypted companion columns.
- Woo payloads are sanitized and should not include patient names, addresses,
  phone numbers, payment instructions, or hand-delivery addresses.
- Catalog snapshots should run from a `systemd` timer or `cron`, not a Redis/RQ worker.

## Failure modes to expect

- Missing `DATA_ENCRYPTION_KEY` or `JWT_SECRET`: boot fails.
- `MYSQL_SSL` not set to `true` in production: boot fails.
- `FRONTEND_BASE_URL` not using `https://`: boot fails.
- Changing `DATA_ENCRYPTION_KEY` after data has been written: decryption fails
  for existing encrypted records.
