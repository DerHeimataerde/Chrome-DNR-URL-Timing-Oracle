# Chrome DNR URL Timing Oracle — PoC

> **Research purposes only.** This repository demonstrates a browser vulnerability for responsible disclosure and academic study.

A proof-of-concept Chrome extension that silently leaks the full URL of background tabs using **only the `declarativeNetRequest` permission** as the timing oracle — no `tabs` permission, no host permissions, no user interaction. The `storage` permission is used solely for auxiliary state (caching results, persisting configuration) and plays no role in the URL leak itself.

---

## Vulnerability Summary

The `declarativeNetRequest` API allows extensions to dynamically add blocking rules that match URLs using regular expressions. Blocked requests fail immediately with `net::ERR_BLOCKED_BY_CLIENT` (~1–5 ms), while allowed requests make a real network connection (~50–2000 ms depending on the server).

By measuring the time between calling `chrome.tabs.reload` and receiving the `status === "complete"` event via `chrome.tabs.onUpdated`, an extension can determine whether a URL matched a regex pattern. A binary search over the character set resolves each character of the URL in O(log n) iterations.

```
blocked  →  ~1–5 ms   (net::ERR_BLOCKED_BY_CLIENT, no network trip)
allowed  →  ~50 ms+   (real connection to server)
```

The attack works entirely in a background service worker with no visible UI changes to the user.

### Affected Versions

| Channel | Version |
|---------|---------|
| Stable  | 144.0.7559.97 |
| Beta    | 145.0.7632.18 |
| Dev     | 146.0.7647.4  |
| Canary  | 146.0.7653.0  |

**OS:** Windows 11 24H2

### Root Cause

Regex rule evaluation for dynamic DNR rules was introduced in:
[`1539dcc828ee`](https://chromium.googlesource.com/chromium/src/+/1539dcc828ee3ba96c0949f1202cf9139b883d82)

The regression range was bisected to revisions `718858–718878`:
[`baac8ed1...f440c125`](https://chromium.googlesource.com/chromium/src/+log/baac8ed132e87c88164423e921b6b4a4352aae62..f440c12523cd84cb6f6c058d4671e103b7c71d27)

A variant of this technique is likely exploitable as far back as the introduction of the Dynamic Rules API:
[chromium-review/1531023](https://chromium-review.googlesource.com/c/chromium/src/+/1531023)

---

## Impact

A malicious extension can silently extract sensitive information from any open tab without user interaction or visible indicators. The attack window includes:

- **OAuth tokens / authorization codes** — `https://example.com/callback?code=<token>`
- **Session tokens in query strings** — API keys, auth tokens passed in URLs
- **Private content URLs** — unlisted YouTube videos, Google Drive share links, Dropbox links
- **Password reset tokens** — `https://example.com/reset?token=<secret>`
- **Sensitive search queries** — medical, financial, personal searches
- **Local network services** — NAS devices, routers, home automation (`http://192.168.x.x/...`)

The attack can be made completely silent by running against background tabs, requiring no foreground activity and producing no visible reloads from the user's perspective.

---

## Repository Structure

```
.
├── .gitignore
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker — timing oracle, leak engine, encryption
├── popup.html           # Extension popup UI
├── popup.js             # Popup logic — start/pause, live status, server config
├── issue.md             # Chromium bug report draft
├── demo/
│   └── index.html       # PoC demo/explainer page
└── server/
    ├── server.js        # Express collection server with IP profiling
    ├── package.json
    ├── profiles.json    # Persisted IP profiles — created on first upload (gitignored)
    ├── uploads/         # Raw upload staging directory
    └── public/
        └── dashboard.html  # Live dashboard — profiles by IP, with clear controls
```

---

## How It Works

1. The extension sets a dynamic DNR blocking rule with a regex matching a character subset at position *i* of the URL.
2. `chrome.tabs.reload()` triggers a navigation on the target tab.
3. A per-probe `chrome.tabs.onUpdated` listener waits for `loading` then `complete`, measuring elapsed time.
   - If elapsed time falls **below** the lower edge of the ambiguous band → immediately classified as **blocked**.
   - If elapsed time falls **above** the upper edge of the ambiguous band → immediately classified as **allowed** (early exit; no need to wait for the page to finish loading).
   - If elapsed time falls **within** the band → additional confirmation probes are taken (adaptive voting).
4. A blocked result means the URL matches the current regex → the tested character set contains the next character.
5. Binary search narrows the character down in ~7 iterations per position, with double-verification on the final candidate.
6. The leaked URL is AES-256-GCM encrypted and POSTed to the collection server.

### Features of this PoC

- **Auto-calibration** — measures real blocked vs. unblocked round-trip times at runtime; adapts to LAN, WAN, and VPN environments
- **Adaptive voting oracle** — timing samples that fall inside a configurable *ambiguous band* around the threshold trigger additional confirmation probes instead of deciding immediately, reducing false positives caused by network jitter
- **Early allow-exit** — "allow" probes return as soon as elapsed time exceeds the upper edge of the ambiguous band, eliminating the need to wait for the full page load on non-matching probes and roughly halving per-character time on fast connections
- **Double-verification** — when binary search narrows to a single candidate character, it is probed twice before being accepted, guarding against a single noisy sample killing the leak
- **Catch-all null guard** — if character narrowing returns no result, a full-alphabet probe confirms whether more characters actually remain; false nulls caused by timing noise are retried rather than treated as end-of-URL
- **Periodic recalibration** — after every 20 leaked characters the oracle re-measures blocked/unblocked timing; detects threshold drift caused by bot-detection interstitials loading as fast as a DNR block
- **Prefix validation with backtrack** — every 15 characters the accumulated prefix is verified against the live URL; on failure the engine recalibrates and trims the last 5 characters before retrying, recovering from corruption due to noise or anti-bot redirects
- **Inter-probe jitter** — a configurable random delay (default 400–1200 ms) is inserted between reloads to avoid triggering bot-detection rate limits on the target site; disabled by default for maximum speed, can be enabled if the target site rate-limits requests
- **Background-only operation** — only leaks tabs that are not currently active; skips the foreground tab entirely
- **Pause / resume** — if a background tab is brought into focus mid-leak, the leak is paused and resumes from the same character position when the tab goes back to background
- **Partial exfiltration on close** — if a tab is closed before the leak completes, the partial URL is exfiltrated immediately
- **Multi-tab queue** — all open background tabs are queued and leaked sequentially at startup
- **IP profiling** — the server groups leaked URLs by client IP, building a browsing profile per user
- **AES-256-GCM encryption** — all exfiltrated data is encrypted with a pre-shared key before transmission
- **Configurable popup UI** — all tuning parameters are adjustable live from the extension popup (see [Configuration](#configuration) below) without reloading the extension

---

## Configuration

All settings are accessible from the extension popup via collapsible sections and take effect immediately without restarting the extension.

| Setting | Default | Description |
|---|---|---|
| **Max URL Length** | 128 | Maximum number of characters to leak per URL. Increase for long URLs with query strings or tokens. |
| **Ambiguity Factor** | 0.4 | Width of the uncertain timing band as a fraction of the calibrated threshold. Samples inside `[threshold × (1−f), threshold × (1+f)]` trigger extra confirmation votes. `0` = fastest (single sample, noisiest). `0.4` = ±40% band (recommended). `1.0` = always take all votes (slowest, most robust). |
| **Jitter (enable/disable)** | Disabled | Toggle all inter-probe delays on or off. |
| **Jitter Min / Max** | 400 / 1200 ms | Random wait range inserted before each reload. Higher values reduce bot-detection risk; lower values speed up the leak. |
| **Recalibrate Every** | 20 chars | Re-measure blocked/unblocked timing after this many confirmed characters. Detects oracle drift caused by bot-detection interstitials. Set to `0` to disable. |
| **Validate Every** | 15 chars | Verify the accumulated prefix still matches the live URL after this many characters. Catches corruption from noise or anti-bot redirects. Set to `0` to disable. |
| **Backtrack Length** | 5 chars | Number of characters trimmed from the prefix when validation fails, before retrying from that position. |
| **Null Confirm Rounds** | 3 misses | Number of consecutive positions where no character is found (with no catch-all match) required before the engine accepts end-of-URL. Higher values prevent premature termination at the cost of a few extra probes per URL. |
| **Exfil Server URL** | `http://localhost:3000` | Collection server endpoint. Connection is tested before saving. |

---

## Setup & Reproduction

### 1. Start the collection server

```bash
cd server
npm install
npm start
```

Server runs on `http://localhost:3000`.  
Dashboard: `http://localhost:3000`

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the repository root

### 3. Observe

- Open target tabs in the background (e.g. `https://accounts.google.com/callback?code=secret`)
- Open the extension's **service worker DevTools** (`chrome://extensions` → service worker link)
- Watch the console for calibration output and character-by-character URL leak:

```
[*] Calibrating timing oracle...
[*] Calibration done: blocked=3ms, unblocked=820ms, threshold=249ms
[*] Detected scheme: https://
[+] https://a
[+] https://ac
[+] https://acc
...
[*] Tab 123 leaked: https://accounts.google.com/callback?code=s3cr3t
```

- Check the dashboard at `http://localhost:3000` for the full IP-grouped profile

---

## Permissions Used

| Permission | Purpose |
|---|---|
| `declarativeNetRequest` | **The sole mechanism of the URL leak** — set/clear regex blocking rules to distinguish blocked (~1–5 ms) from allowed (~50 ms+) navigations |
| `storage` | Auxiliary only — cache results and persist configuration between service worker restarts; not involved in URL inference |

No `tabs`, no `host_permissions`, no `webRequest`.

---

## Demo

https://github.com/user-attachments/assets/cb51d32e-db68-4018-a849-8ed63797ee1b

---

## Credit

**Vulnerability discovered and reported by:**  
**Luan Herrera** ([@lbherrera_](https://twitter.com/lbherrera_))

This PoC is an extended research implementation based on the original proof of concept authored by Luan Herrera and submitted as a security bug report to the Chromium project.

---

## Disclaimer

This code is provided strictly for **security research, education, and responsible disclosure** purposes. Do not use this tool against systems or users without explicit authorization. The authors accept no liability for misuse.
