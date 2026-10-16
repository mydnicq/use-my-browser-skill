---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs logs    <target> [flags...]         # console output buffered since daemon attached
                                                   # flags (combinable): all | errors | warn | info | log | debug | exception
                                                   #                     source=console | source=exception | source=browser
                                                   #                     last=N | grep=<text>
scripts/cdp.mjs logdetail <target> <N>             # full text of entry N (index shown in logs output)
scripts/cdp.mjs netlog   <target> [flags...]        # network requests buffered since daemon attached
                                                   # flags (combinable): failed | blocked | method=GET|POST|...
                                                   #                     status=N | grep=<url-text> | last=N
scripts/cdp.mjs netdetail <target> <N>             # full JSON details of network entry N (index shown in netlog)
scripts/cdp.mjs open    [url]                  # open new tab (no extra Allow prompt)
scripts/cdp.mjs close   <target>               # close a tab
scripts/cdp.mjs stop    [target]               # detach from one tab, or stop the daemon
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow remote debugging?" prompt for every new WebSocket connection. All commands go through one background daemon that holds a single connection for all tabs, so the user approves once per daemon. The daemon auto-exits after 2 hours of inactivity (`CDP_IDLE_MINUTES`) or when Chrome disconnects.
- While the prompt is open, commands print `Waiting for "Allow remote debugging?" approval in Chrome...` and wait up to 120s. Tell the user to click Allow; do not retry in a loop, and do not run `stop` unless you're done, since the next command will prompt again.
