# CODEX.md

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
