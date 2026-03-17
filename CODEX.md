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
