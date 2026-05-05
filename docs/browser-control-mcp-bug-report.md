# Browser Control MCP Bug Report

Date: 2026-05-05
Repo under test: `/Users/derrickburns/Code/genealogy-flow`
App URL used: `http://127.0.0.1:8788/`
MCP provider: `kindred_local_cdp_browser`
Provider version reported: `browser-control-mcp.v1`
CDP URL reported: `http://127.0.0.1:18800`

## Summary

The browser-control MCP is reachable and can navigate/capture pages, but several behaviors make it unreliable for UI QA:

1. Safety cancellation blocked an explicitly requested local navigation.
2. Requested viewport sizes are ignored or silently clamped without a warning.
3. Capture results include hidden modal headings and hidden controls as if they are visible.
4. Text-click operations can report success while clicking the wrong duplicate/hidden element.
5. Capture output provides numeric control refs, but there is no matching click-by-ref API.

These issues make it hard to verify responsive UI changes and impossible to trust some click/capture results without manual screenshot inspection.

## Environment

- macOS, Chrome controlled through local CDP.
- App served by `pnpm run dev`, Cloudflare Pages dev on `http://localhost:8788`.
- Browser MCP page IDs observed:
  - `cdp:94B439B825EE49C6E6DD5FB295DAABEE`
  - `cdp:24A4188654DC74D37ACA9ADEF75CA8B2`
- Chrome window bounds often reported as `width: 942, height: 1164` even when smaller viewport values were requested.

## Issue 1: Local Navigation Incorrectly Cancelled By Safety Layer

### Repro

Call:

```json
{
  "url": "http://localhost:8788/",
  "page_id": "cdp:3D1FD692D24BFB528643513A57E56BDA",
  "client_window": false,
  "wait_until": "load",
  "timeout_ms": 20000,
  "screenshot": true,
  "max_text_chars": 6000,
  "lock_timeout_ms": 10000,
  "window_width": 500,
  "window_height": 844
}
```

### Actual

The tool call was cancelled with a safety-risk message saying the payload involved remote control, commits, pushing, and emailing. The current action was only local browser navigation against `localhost`.

### Expected

The MCP should navigate the local page. Prior conversation context about commits or email should not cause a local browser-control call to be cancelled after the user explicitly asked to use the browser-control MCP.

### Severity

High. It blocks the primary requested workflow.

## Issue 2: Requested Viewport Size Is Ignored Or Silently Clamped

### Repro A

Call `browser_capture_page` on an existing page with:

```json
{
  "window_width": 390,
  "window_height": 844,
  "screenshot": true
}
```

### Actual A

The result still reported:

```json
"bounds": {
  "width": 942,
  "height": 1164
}
```

The page remained in the desktop layout.

### Repro B

Call `browser_navigate` with:

```json
{
  "new_window": true,
  "window_width": 390,
  "window_height": 844
}
```

### Actual B

The window was created at:

```json
"bounds": {
  "width": 500,
  "height": 844
}
```

This may be a Chrome minimum width, but the MCP did not warn that it could not honor the requested width.

### Expected

Either:

- apply the requested viewport/window dimensions, or
- return a clear warning such as `requested width 390 was clamped to 500`.

For responsive QA, the effective viewport must be explicit and reliable.

### Severity

High for mobile UI testing.

## Issue 3: Capture Includes Hidden Headings And Controls

### Repro

1. Navigate to the app.
2. Accept/dismiss the terms and splash overlays.
3. Capture the page.

### Actual

The `visible_text` no longer showed the terms modal, but the `headings` array still included hidden modal headings such as:

- `Before using Kindred Flow`
- `Use at your own risk`
- `No professional advice`
- `Your data and permissions`
- `Privacy of living people`
- `Third-party services`
- `Limitation of liability`
- `Indemnity`

The `controls` array also continued to include hidden controls:

- `Enter Kindred Flow`
- `I agree and continue`
- `Cancel`
- `Continue to upload`

### Expected

`visible_text`, `headings`, `links`, and `controls` should all consistently exclude elements that are not interactable/visible, including:

- `[hidden]`
- `display: none`
- `visibility: hidden`
- hidden ancestors
- inert/aria-hidden modal layers

If hidden elements are intentionally included, they should be separated under a different field such as `hidden_controls`.

### Severity

High. It makes the structured page snapshot misleading and affects click targeting.

## Issue 4: Click By Text Can Report Success Without Activating The Intended UI

### Repro

On a mobile-sized/new-window capture, visible text showed the mobile tab row:

```text
MAP
PEOPLE
CLUSTER
TREES
TOUR
AI
```

Call:

```json
{
  "text": "People",
  "exact": true
}
```

### Actual

The tool returned `status: "complete"`, but the page did not open the People sheet. The subsequent capture did not show the People controls.

The capture included multiple controls/labels containing `People`, including hidden or non-target elements, so the click likely matched the wrong element.

### Expected

The tool should either:

- click the topmost visible interactable element with that accessible text, or
- fail with an ambiguity error listing all candidate elements, or
- support click-by-ref using the refs already returned in `controls`.

Returning success when the intended UI state does not change is unsafe for QA automation.

### Severity

High for interaction testing.

## Issue 5: Capture Gives Refs But Click API Cannot Use Them

### Repro

`browser_capture_page` returns controls like:

```json
{
  "ref": 28,
  "tag": "button",
  "label": "People"
}
```

But the available click tool is only `browser_click_text`; there is no `browser_click_ref`.

### Expected

Add a click API that targets the stable refs returned by capture:

```json
{
  "ref": 28
}
```

This would avoid duplicate-text ambiguity and make captures actionable.

### Severity

Medium-high. It is the main missing primitive for reliable UI QA.

## Suggested Fixes

1. Filter captured headings/links/controls through computed visibility and hit-test interactability.
2. Add `browser_click_ref` using the `ref` values emitted by `browser_capture_page`.
3. For `browser_click_text`, detect duplicate candidates and prefer visible, topmost, enabled controls; warn or fail on ambiguity.
4. Honor `window_width`/`window_height` in `browser_capture_page`, or document that capture cannot resize existing windows.
5. Emit warnings when requested viewport dimensions are clamped by Chrome or the OS.
6. Keep safety checks scoped to the active browser action. A local navigation should not be cancelled because of unrelated prior actions in conversation history.

## Impact

These failures directly affected UI refactor QA:

- Could not reliably force a mobile viewport in the leased Chrome tab.
- Could not trust structured snapshot output because hidden modal controls remained present.
- Could not reliably click the People mobile tab due duplicate/hidden text matching.
- Had to infer UI state from screenshots and fallback behavior instead of clean MCP assertions.

