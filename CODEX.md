# CODEX.md

## Development Priority
- The Python-backed version is the primary product and the source of truth for development decisions.
- When behavior differs between Python and Node, prioritize matching or preserving the Python version unless the user explicitly asks for Node-specific work.
- Treat Node parity and Node-only fixes as secondary follow-up work unless they are explicitly requested or required to unblock the user.

## UI Verification
- Default visual verification method: capture the active Safari `localhost` window, not the entire screen and not a fresh unauthenticated browser session.
- First confirm Safari is on the intended local page.
- Then capture the front Safari window bounds into `artifacts/` so the screenshot reflects the user's real current state.
- Use browser-only Playwright screenshots as fallback when Safari capture is not possible, but treat them as secondary because they may land on the login page or miss the user's live session state.

## Commands
- Confirm Safari front tab URL:
  - `osascript -e 'tell application "Safari" to return URL of current tab of front window'`
- Capture only the active Safari window:
  - `osascript -e 'tell application "Safari" to activate' && mkdir -p artifacts && RECT=$(osascript <<'APPLESCRIPT'
tell application "System Events"
  tell process "Safari"
    set p to position of front window
    set s to size of front window
    set x to item 1 of p
    set y to item 2 of p
    set w to item 1 of s
    set h to item 2 of s
    return (x as string) & "," & (y as string) & "," & (w as string) & "," & (h as string)
  end tell
end tell
APPLESCRIPT
) && screencapture -x -R"$RECT" artifacts/safari-window-localhost.png`
- Fallback browser-only capture:
  - `npm run screenshot:local -- http://127.0.0.1:3000 artifacts/localhost-browser-only.png`

## Frontend Zip Packaging
- For any `frontend_flattened_vX.XX.XX.zip` request, always run a fresh production build first.
- The archive must be truly flattened: `index.html`, `assets/`, `content/`, and other build outputs must live at the zip root.
- Do not zip the `build/` directory itself from the repo root, or the archive will unpack into a nested `build/` folder and deploy incorrectly.
- Create the archive from inside `build/` so the contents of `build/` become the top level of the zip.
- After creating the zip, verify it contains `index.html` and hashed files under `assets/` at the archive root before handing it off.

## Frontend Zip Commands
- Fresh build:
  - `npm run build`
- Remove old archive:
  - `rm -f frontend_flattened_vX.XX.XX.zip`
- Create the correctly flattened archive:
  - `cd build && zip -r ../frontend_flattened_vX.XX.XX.zip .`
- Verify the archive shape:
  - `unzip -l frontend_flattened_vX.XX.XX.zip | head -20`
  - `unzip -l frontend_flattened_vX.XX.XX.zip | egrep '(^\\s*[0-9].*index.html$)|(^\\s*[0-9].*assets/index-.*\\.(css|js)$)'`

## VPS Backfill Runbook
- On the VPS, do not use `public_html/.htaccess` for backend env discovery. The live Python backend runs under `systemd` as `peppr-api.service`.
- The real runtime env file is `/etc/peppr-api.env`.
- The live backend process is `gunicorn python_backend.wsgi:app` started from `/opt/peppr/backend` with the virtualenv at `/opt/peppr/backend/venv`.
- The ship date backfill script currently needs one runtime override when run manually on the VPS:
  - set `DATA_DIR=/opt/peppr/backend/server-data`
  - disable CLI bootstrap inside the script so it does not re-import stale cPanel/Passenger env from `.htaccess`

## Backfill Commands
- Export the same env used by the service:
  - `eval "$(sudo awk -F= '`
  - `  /^[A-Z0-9_]+=/{`
  - `    key=$1`
  - `    sub(/^[^=]+=/,"",$0)`
  - `    gsub(/"/,"\\\"",$0)`
  - `    printf("export %s=\"%s\"\\n", key, $0)`
  - `  }`
  - `' /etc/peppr-api.env)"`
- Override the writable data dir and activate the venv:
  - `export DATA_DIR=/opt/peppr/backend/server-data`
  - `source /opt/peppr/backend/venv/bin/activate`
- Dry run the ship-date repair:
  - `python - <<'PY'`
  - `from python_backend.scripts import backfill_shipdates as b`
  - `b._bootstrap_cli_env = lambda: None`
  - `b.run(apply=False, force=True, limit=500, offset=0, sleep_ms=120, require_tracking=False)`
  - `PY`
- Apply the ship-date repair:
  - `python - <<'PY'`
  - `from python_backend.scripts import backfill_shipdates as b`
  - `b._bootstrap_cli_env = lambda: None`
  - `b.run(apply=True, force=True, limit=500, offset=0, sleep_ms=120, require_tracking=False)`
  - `PY`

## DB Verification
- Verify the live service env source:
  - `systemctl cat peppr-api.service`
  - `sudo egrep '^(MYSQL_|DATA_DIR|DOTENV_CONFIG_PATH|SHIPSTATION_|ORDER_TIMEZONE)=' /etc/peppr-api.env`
- Verify the repaired `shipped_at` value for order `1469`:
  - `python - <<'PY'`
  - `import os, pymysql`
  - `conn = pymysql.connect(host=os.environ["MYSQL_HOST"], port=int(os.environ["MYSQL_PORT"]), user=os.environ["MYSQL_USER"], password=os.environ["MYSQL_PASSWORD"], database=os.environ["MYSQL_DATABASE"], charset="utf8mb4", autocommit=True)`
  - `with conn.cursor() as cur:`
  - `    cur.execute("""`
  - `        SELECT id, woo_order_number, shipped_at`
  - `        FROM orders`
  - `        WHERE woo_order_number = '1469'`
  - `           OR id = '1772645880200'`
  - `    """)`
  - `    print(cur.fetchall())`
  - `conn.close()`
  - `PY`
