const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, powerMonitor, dialog } = require("electron");
const path = require("path");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const Store = require("electron-store");
const AutoLaunch = require("auto-launch");

// ─── SINGLE INSTANCE LOCK ───
// Edge case #7: Prevent multiple instances from corrupting the store
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ─── ENCRYPTED STORE ───
const ENCRYPTION_KEY = "tp-" + os.hostname() + "-" + os.userInfo().username;
let store;

// Edge case #2: Store corruption recovery
try {
  store = new Store({ encryptionKey: ENCRYPTION_KEY });
  // Test read — if corrupted, this throws
  store.get("totalSeconds");
} catch (err) {
  console.error("Store corrupted, attempting recovery...", err.message);
  // Delete corrupted store
  const storePath = path.join(app.getPath("userData"), "config.json");
  try { fs.unlinkSync(storePath); } catch {}
  // Create fresh store
  store = new Store({ encryptionKey: ENCRYPTION_KEY });
  // Will be recovered from iCloud backup below
}

// ─── ENCRYPTED BACKUPS ───
const BACKUP_ALGO = "aes-256-gcm";
const BACKUP_KEY_SEED = "TerminalPulse-backup-" + os.userInfo().username;
const ICLOUD_PATH = path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/TerminalPulse");

function deriveBackupKey() {
  return crypto.scryptSync(BACKUP_KEY_SEED, "terminalpulse-salt", 32);
}

function encryptData(plaintext) {
  const key = deriveBackupKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(BACKUP_ALGO, key, iv);
  let encrypted = cipher.update(plaintext, "utf-8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return JSON.stringify({ iv: iv.toString("hex"), tag, data: encrypted });
}

function decryptData(blob) {
  const { iv, tag, data } = JSON.parse(blob);
  const key = deriveBackupKey();
  const decipher = crypto.createDecipheriv(BACKUP_ALGO, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let decrypted = decipher.update(data, "hex", "utf-8");
  decrypted += decipher.final("utf-8");
  return decrypted;
}

// ─── BACKUP KEY WHITELIST & VALIDATION ───
const ALLOWED_STORE_KEYS = new Set([
  "totalSeconds", "dailyData", "achievements", "currentStreak", "longestStreak",
  "level", "xp", "aiSeconds", "dailyAiData", "toolSeconds", "dailyToolData",
  "projectSeconds", "dailyProjectData", "todayCommits", "totalCommits",
  "dailyCommits", "activeTools", "autoLaunchConfigured", "migrationDone",
  "sessions", "bestSessionSeconds",
]);

function validateBackupData(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const clean = {};
  for (const [key, val] of Object.entries(data)) {
    if (!ALLOWED_STORE_KEYS.has(key)) continue;
    if (["totalSeconds", "currentStreak", "longestStreak", "level", "xp",
         "aiSeconds", "todayCommits", "totalCommits"].includes(key)) {
      if (typeof val !== "number" || val < 0) continue;
    }
    if (key === "achievements") {
      if (!Array.isArray(val) || !val.every(v => typeof v === "string" && v.length < 50)) continue;
    }
    if (["dailyData", "dailyAiData", "dailyCommits"].includes(key)) {
      if (typeof val !== "object" || val === null) continue;
      if (!Object.entries(val).every(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === "number" && v >= 0)) continue;
    }
    if (key === "activeTools") {
      if (!Array.isArray(val) || !val.every(v => typeof v === "string" && v.length < 100)) continue;
    }
    clean[key] = val;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

// ─── RECOVERY: Always sync with iCloud backup on startup ───
// If iCloud backup has MORE data than local store, restore it.
// This handles: corruption, rebuilds, fresh installs, any data loss.
function attemptRecoveryFromBackup() {
  const localTotal = store.get("totalSeconds") || 0;

  // Helper: merge backup into store if it has more data
  function mergeIfBetter(data) {
    const validated = validateBackupData(data);
    if (!validated) return false;
    const backupTotal = validated.totalSeconds || 0;
    if (backupTotal > localTotal) {
      // Backup has more data — merge it in
      // For daily data, keep the max of each day
      const mergeKeys = ["dailyData", "dailyAiData", "dailyCommits", "dailyToolData", "dailyProjectData"];
      for (const [key, val] of Object.entries(validated)) {
        if (mergeKeys.includes(key) && typeof val === "object") {
          const current = store.get(key) || {};
          for (const [dk, dv] of Object.entries(val)) {
            if (typeof dv === "number") {
              current[dk] = Math.max(current[dk] || 0, dv);
            } else if (typeof dv === "object" && dv !== null) {
              // For nested objects like dailyToolData[date][tool]
              if (!current[dk]) current[dk] = {};
              for (const [sk, sv] of Object.entries(dv)) {
                current[dk][sk] = Math.max(current[dk][sk] || 0, sv);
              }
            }
          }
          store.set(key, current);
        } else if (key === "achievements") {
          const merged = [...new Set([...(store.get("achievements") || []), ...(val || [])])];
          store.set("achievements", merged);
        } else if (["toolSeconds", "projectSeconds"].includes(key) && typeof val === "object") {
          const current = store.get(key) || {};
          for (const [k, v] of Object.entries(val)) {
            current[k] = Math.max(current[k] || 0, v);
          }
          store.set(key, current);
        } else {
          store.set(key, val);
        }
      }
      console.log(`Recovered: local had ${localTotal}s, backup had ${backupTotal}s`);
      return true;
    }
    return false;
  }

  // Try encrypted iCloud backup
  try {
    const encBackup = path.join(ICLOUD_PATH, "terminalpulse-backup.enc");
    if (fs.existsSync(encBackup)) {
      const data = JSON.parse(decryptData(fs.readFileSync(encBackup, "utf-8")));
      if (mergeIfBetter(data)) return;
    }
  } catch (e) { console.log("Encrypted backup read failed:", e.message); }

  // Try weekly snapshots (most recent first)
  try {
    if (fs.existsSync(ICLOUD_PATH)) {
      const snapshots = fs.readdirSync(ICLOUD_PATH)
        .filter(f => f.startsWith("terminalpulse-backup-") && f.endsWith(".enc"))
        .sort().reverse();
      for (const snap of snapshots) {
        try {
          const data = JSON.parse(decryptData(fs.readFileSync(path.join(ICLOUD_PATH, snap), "utf-8")));
          if (mergeIfBetter(data)) return;
        } catch {}
      }
    }
  } catch {}

  // Try old unencrypted JSON backup (migration)
  try {
    const jsonBackup = path.join(ICLOUD_PATH, "terminalpulse-backup.json");
    if (fs.existsSync(jsonBackup)) {
      const data = JSON.parse(fs.readFileSync(jsonBackup, "utf-8"));
      if (mergeIfBetter(data)) return;
    }
  } catch {}

  if (localTotal === 0) console.log("No backup found — starting fresh");
  else console.log(`Local store is current: ${localTotal}s`);
}

attemptRecoveryFromBackup();

// ─── STORE DEFAULTS ───
const defaults = {
  totalSeconds: 0, dailyData: {}, achievements: [], currentStreak: 0,
  longestStreak: 0, level: 1, xp: 0, aiSeconds: 0, dailyAiData: {},
  toolSeconds: {}, dailyToolData: {}, projectSeconds: {}, dailyProjectData: {},
  todayCommits: 0, totalCommits: 0, dailyCommits: {}, activeTools: [],
  sessions: {}, bestSessionSeconds: 0,
};
for (const [key, val] of Object.entries(defaults)) {
  if (store.get(key) === undefined) store.set(key, val);
}

// ─── BACKUP SYSTEM ───
let backupInterval;

function getBackupData() {
  // Flush memory first so backup has latest data
  flushMemoryToStore();
  const data = {};
  for (const key of ALLOWED_STORE_KEYS) {
    const val = memoryState[key] !== undefined ? memoryState[key] : store.get(key);
    if (val !== undefined) data[key] = val;
  }
  return JSON.stringify(data, null, 2);
}

function autoBackupToICloud() {
  try {
    const icloudBase = path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs");
    if (!fs.existsSync(icloudBase)) return false;
    if (!fs.existsSync(ICLOUD_PATH)) fs.mkdirSync(ICLOUD_PATH, { recursive: true });

    const backupFile = path.join(ICLOUD_PATH, "terminalpulse-backup.enc");
    fs.writeFileSync(backupFile, encryptData(getBackupData()), "utf-8");

    const weekKey = new Date().toISOString().split("T")[0];
    const weeklyFile = path.join(ICLOUD_PATH, `terminalpulse-backup-${weekKey}.enc`);
    if (!fs.existsSync(weeklyFile)) {
      fs.writeFileSync(weeklyFile, encryptData(getBackupData()), "utf-8");
      const files = fs.readdirSync(ICLOUD_PATH)
        .filter(f => f.startsWith("terminalpulse-backup-") && f.endsWith(".enc"))
        .sort().reverse();
      for (const old of files.slice(8)) fs.unlinkSync(path.join(ICLOUD_PATH, old));
    }
    return true;
  } catch (err) {
    console.error("iCloud backup failed:", err.message);
    return false;
  }
}

function exportBackup() {
  const savePath = dialog.showSaveDialogSync(mainWindow, {
    title: "Export TerminalPulse Backup",
    defaultPath: `terminalpulse-backup-${new Date().toISOString().split("T")[0]}.enc`,
    filters: [{ name: "Encrypted Backup", extensions: ["enc"] }],
  });
  if (savePath) {
    fs.writeFileSync(savePath, encryptData(getBackupData()), "utf-8");
    return true;
  }
  return false;
}

function importBackup() {
  const filePaths = dialog.showOpenDialogSync(mainWindow, {
    title: "Import TerminalPulse Backup",
    filters: [{ name: "Encrypted Backup", extensions: ["enc"] }],
    properties: ["openFile"],
  });
  if (filePaths && filePaths[0]) {
    try {
      const raw = fs.readFileSync(filePaths[0], "utf-8");
      const decrypted = decryptData(raw);
      const data = JSON.parse(decrypted);
      const validated = validateBackupData(data);
      if (!validated) return { success: false, message: "Invalid or corrupted backup data" };
      for (const [key, val] of Object.entries(validated)) store.set(key, val);
      return { success: true, message: `Restored ${Math.round((validated.totalSeconds || 0) / 3600)}h of data` };
    } catch {
      return { success: false, message: "Failed to decrypt — wrong machine or corrupted file" };
    }
  }
  return { success: false, message: "No file selected" };
}

function startAutoBackup() {
  autoBackupToICloud();
  // Backup every 5 minutes (was 1 min — unnecessary disk + crypto work)
  backupInterval = setInterval(autoBackupToICloud, BACKUP_INTERVAL);
}

// ─── AUTO-LAUNCH ───
const autoLauncher = new AutoLaunch({
  name: "TerminalPulse",
  path: app.getPath("exe"),
  isHidden: true,
});

let mainWindow;
let tray;
let trackingInterval;
let idleUpdateInterval;
let isTerminalActive = false;
let sessionStart = null;
let lastDateKey = null; // Edge case #3: Track date changes

// ─── ENERGY OPTIMIZATION: TRACKING INTERVALS ───
const TRACK_INTERVAL_SECONDS = 5;      // Main loop runs every 5s instead of 1s
const AI_CHECK_INTERVAL = 10;           // Check AI tools every 10s
const DEV_TOOL_CHECK_INTERVAL = 30;     // Check dev tools every 30s
const PROJECT_CHECK_INTERVAL = 60;      // Check project every 60s
const COMMIT_CHECK_INTERVAL = 300;      // Check commits every 5 min
const IDLE_UPDATE_INTERVAL = 30000;     // Send idle updates every 30s
const BACKUP_INTERVAL = 300000;         // Backup every 5 min
const STORE_FLUSH_INTERVAL = 30000;     // Flush in-memory data to disk every 30s

let trackTickCounter = 0; // counts seconds of active tracking

// ─── ENERGY OPTIMIZATION: IN-MEMORY ACCUMULATOR ───
// Batch store writes instead of writing every second
const memoryState = {
  totalSeconds: store.get("totalSeconds") || 0,
  aiSeconds: store.get("aiSeconds") || 0,
  dailyData: store.get("dailyData") || {},
  dailyAiData: store.get("dailyAiData") || {},
  toolSeconds: store.get("toolSeconds") || {},
  dailyToolData: store.get("dailyToolData") || {},
  projectSeconds: store.get("projectSeconds") || {},
  dailyProjectData: store.get("dailyProjectData") || {},
  achievements: store.get("achievements") || [],
  currentStreak: store.get("currentStreak") || 0,
  longestStreak: store.get("longestStreak") || 0,
  level: store.get("level") || 1,
  xp: store.get("xp") || 0,
  activeTools: store.get("activeTools") || [],
  todayCommits: store.get("todayCommits") || 0,
  totalCommits: store.get("totalCommits") || 0,
  dailyCommits: store.get("dailyCommits") || {},
  sessions: store.get("sessions") || {},
  bestSessionSeconds: store.get("bestSessionSeconds") || 0,
  dirty: false, // track if we need to flush
};

let storeFlushInterval;
let cachedStats = null;
let statsCacheDirty = true;

function flushMemoryToStore() {
  if (!memoryState.dirty) return;
  for (const key of ALLOWED_STORE_KEYS) {
    if (memoryState[key] !== undefined) {
      store.set(key, memoryState[key]);
    }
  }
  memoryState.dirty = false;
  console.log("Flushed in-memory state to disk");
}

// ─── ENERGY OPTIMIZATION: COMBINED PROCESS SCAN ───
// Single `ps` call for both AI tools and dev tools
let cachedProcessLines = [];
let lastProcessScanTime = 0;

function scanProcesses() {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "command="], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      cachedProcessLines = stdout.split("\n");
      lastProcessScanTime = Date.now();
      resolve(cachedProcessLines);
    });
  });
}

function detectAIToolsFromLines(lines) {
  const aiTools = [
    { name: "Pi (Coding Agent)", test: (line) => /\bpi\s*$/.test(line.trim()) || /\spi\s+--/.test(line) },
    { name: "Claude Code", test: (line) => /\bclaude\b/.test(line) && !/claudehelper/i.test(line) },
    { name: "Aider", test: (line) => /\baider\b/.test(line) },
    { name: "GitHub Copilot", test: (line) => /\bcopilot\b/.test(line) },
    { name: "Cursor", test: (line) => /\bcursor\b/i.test(line) && /cursor\s/.test(line) },
    { name: "Continue", test: (line) => /\bcontinue\b/.test(line) && /continue\s+--/.test(line) },
  ];
  const detected = [];
  for (const tool of aiTools) {
    if (lines.some((line) => tool.test(line.toLowerCase()))) detected.push(tool.name);
  }
  return { isAI: detected.length > 0, tools: detected };
}

function detectDevToolsFromLines(lines) {
  const linesJoined = lines.join("\n").toLowerCase();
  const tools = [
    { name: "Node.js", patterns: [" node "] },
    { name: "Python", patterns: [" python"] },
    { name: "Docker", patterns: ["docker"] },
    { name: "npm", patterns: [" npm "] },
    { name: "Git", patterns: [" git "] },
    { name: "Vim/Neovim", patterns: [" vim ", " nvim "] },
    { name: "SSH", patterns: [" ssh "] },
    { name: "Rust/Cargo", patterns: [" cargo "] },
    { name: "Go", patterns: [" go build", " go run"] },
    { name: "Ruby", patterns: [" ruby ", " rails "] },
    { name: "Java/Gradle", patterns: [" java ", " gradle "] },
  ];
  const detected = [];
  for (const tool of tools) {
    if (tool.patterns.some((p) => linesJoined.includes(p))) detected.push(tool.name);
  }
  return detected;
}

// ─── SESSIONS ───
const SESSION_END_IDLE_SECONDS = 15 * 60; // 15 minutes idle → end session
let currentSession = null; // { startTime, seconds, aiSeconds, tools: Set }
let consecutiveIdleSeconds = 0; // how long the user has been continuously idle

function startNewSession() {
  currentSession = {
    startTime: new Date().toISOString(),
    seconds: 0,
    aiSeconds: 0,
    tools: new Set(),
  };
  consecutiveIdleSeconds = 0;
}

function endCurrentSession() {
  if (!currentSession || currentSession.seconds < 10) {
    currentSession = null;
    return;
  }
  const key = getTodayKey();
  if (!memoryState.sessions[key]) memoryState.sessions[key] = [];
  memoryState.sessions[key].push({
    startTime: currentSession.startTime,
    endTime: new Date().toISOString(),
    seconds: currentSession.seconds,
    aiSeconds: currentSession.aiSeconds,
    tools: [...currentSession.tools],
  });

  if (currentSession.seconds > memoryState.bestSessionSeconds) {
    memoryState.bestSessionSeconds = currentSession.seconds;
  }

  memoryState.dirty = true;
  statsCacheDirty = true;
  currentSession = null;
  consecutiveIdleSeconds = 0;
}

function getTodayKey() {
  // Use local date, not UTC — so the day matches the user's timezone
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ─── IDLE DETECTION ───
// If no keyboard/mouse input for this many seconds, pause tracking
const IDLE_THRESHOLD_SECONDS = 120; // 2 minutes — allows reading terminal output without pausing

function getSystemIdleSeconds() {
  return new Promise((resolve) => {
    execFile("ioreg", ["-c", "IOHIDSystem"], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(0);
      const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
      if (match) {
        // HIDIdleTime is in nanoseconds
        resolve(Math.floor(parseInt(match[1]) / 1000000000));
      } else {
        resolve(0);
      }
    });
  });
}

// ─── DETECTION FUNCTIONS ───

function checkTerminalActive() {
  return new Promise((resolve) => {
    // Only track when a terminal app is the FRONTMOST window
    // TerminalPulse being in front does NOT count — prevents false tracking
    const script =
      'tell application "System Events" to set frontApp to name of first application process whose frontmost is true\nreturn frontApp';
    execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(false);
      const activeApp = stdout.trim().toLowerCase();
      // Exclude TerminalPulse/Electron — they contain "terminal" but aren't terminals
      if (activeApp.includes("terminalpulse") || activeApp.includes("electron")) return resolve(false);
      const terminals = ["terminal", "iterm2", "iterm", "hyper", "alacritty", "kitty", "warp", "wezterm", "tabby"];
      resolve(terminals.some((t) => activeApp.includes(t)));
    });
  });
}

// detectAITools and detectDevTools are now replaced by
// detectAIToolsFromLines() and detectDevToolsFromLines() above
// which operate on cached process lines from a single scanProcesses() call

function detectCurrentProject() {
  return new Promise((resolve) => {
    const script = [
      'tell application "System Events"',
      '  set frontApp to name of first application process whose frontmost is true',
      '  if frontApp contains "Terminal" then',
      '    tell application "Terminal" to return name of front window',
      '  else if frontApp contains "iTerm" then',
      '    tell application "iTerm" to return name of current session of current window',
      '  end if',
      'end tell',
    ].join("\n");
    execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const match = stdout.trim().match(/[~\/][^\s]*/);
      if (match) {
        resolve(getProjectName(match[0].replace("~", os.homedir())));
      } else {
        resolve(null);
      }
    });
  });
}

function getProjectName(dirPath) {
  if (!dirPath) return null;
  try {
    let dir = dirPath;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return path.basename(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.basename(dirPath);
  } catch {
    return path.basename(dirPath);
  }
}

function countTodayCommits() {
  return new Promise((resolve) => {
    const today = getTodayKey();
    const searchDirs = [
      path.join(os.homedir(), "Documents"),
      path.join(os.homedir(), "Projects"),
      path.join(os.homedir(), "Desktop"),
      path.join(os.homedir(), "dev"),
    ].filter(d => fs.existsSync(d));
    if (searchDirs.length === 0) return resolve(0);

    execFile("find", [...searchDirs, "-maxdepth", "3", "-name", ".git", "-type", "d"], { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(0);
      const gitDirs = stdout.trim().split("\n").filter(Boolean);
      let totalCommits = 0;
      let pending = gitDirs.length;
      if (pending === 0) return resolve(0);

      for (const gitDir of gitDirs) {
        const repoDir = path.dirname(gitDir);
        execFile("git", ["-C", repoDir, "config", "user.name"], { timeout: 3000 }, (err1, userName) => {
          const author = (userName || "").trim();
          if (!author) { pending--; if (pending === 0) resolve(totalCommits); return; }
          execFile("git", ["-C", repoDir, "log", "--oneline", `--since=${today}`, `--author=${author}`], { timeout: 3000 }, (err2, stdout2) => {
            if (!err2) totalCommits += stdout2.trim().split("\n").filter(Boolean).length;
            pending--;
            if (pending === 0) resolve(totalCommits);
          });
        });
      }
    });
  });
}

// ─── DATA UPDATES ───

function updateDailyData(seconds) {
  const key = getTodayKey();
  memoryState.dailyData[key] = (memoryState.dailyData[key] || 0) + seconds;
  memoryState.dirty = true;
  statsCacheDirty = true;
}

function updateAIData(seconds) {
  const key = getTodayKey();
  memoryState.aiSeconds += seconds;
  memoryState.dailyAiData[key] = (memoryState.dailyAiData[key] || 0) + seconds;
  memoryState.dirty = true;
  statsCacheDirty = true;
}

function updateToolData(tools, seconds) {
  const key = getTodayKey();
  if (!memoryState.dailyToolData[key]) memoryState.dailyToolData[key] = {};
  for (const tool of tools) {
    memoryState.toolSeconds[tool] = (memoryState.toolSeconds[tool] || 0) + seconds;
    memoryState.dailyToolData[key][tool] = (memoryState.dailyToolData[key][tool] || 0) + seconds;
  }
  memoryState.dirty = true;
  statsCacheDirty = true;
}

function updateProjectData(project, seconds) {
  if (!project) return;
  const key = getTodayKey();
  if (!memoryState.dailyProjectData[key]) memoryState.dailyProjectData[key] = {};
  memoryState.projectSeconds[project] = (memoryState.projectSeconds[project] || 0) + seconds;
  memoryState.dailyProjectData[key][project] = (memoryState.dailyProjectData[key][project] || 0) + seconds;
  memoryState.dirty = true;
  statsCacheDirty = true;
}

function calculateStreak() {
  const daily = memoryState.dailyData;
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split("T")[0];
    if (daily[key] && daily[key] >= 60) {
      streak++;
    } else if (i > 0) {
      break;
    }
  }
  memoryState.currentStreak = streak;
  if (streak > memoryState.longestStreak) memoryState.longestStreak = streak;
  memoryState.dirty = true;
  statsCacheDirty = true;
}

function calculateLevel() {
  const totalMinutes = Math.floor(memoryState.totalSeconds / 60);
  const xp = totalMinutes * 10;
  const level = Math.floor(xp / 1000) + 1;
  memoryState.xp = xp;
  memoryState.level = level;
  memoryState.dirty = true;
  statsCacheDirty = true;
}

// ─── ACHIEVEMENTS ───

const ACHIEVEMENT_DEFS = [
  { id: "first_minute", title: "Hello World", desc: "Spend your first minute in the terminal", icon: "🌱", req: (s) => s.totalSeconds >= 60 },
  { id: "ten_minutes", title: "Getting Warmed Up", desc: "10 minutes of terminal time", icon: "🔥", req: (s) => s.totalSeconds >= 600 },
  { id: "one_hour", title: "Flow State", desc: "1 hour of terminal time", icon: "⚡", req: (s) => s.totalSeconds >= 3600 },
  { id: "five_hours", title: "Terminal Warrior", desc: "5 hours of terminal time", icon: "⚔️", req: (s) => s.totalSeconds >= 18000 },
  { id: "ten_hours", title: "Code Ninja", desc: "10 hours of terminal time", icon: "🥷", req: (s) => s.totalSeconds >= 36000 },
  { id: "twenty_four_hours", title: "Full Day Hero", desc: "24 hours of total terminal time", icon: "🦸", req: (s) => s.totalSeconds >= 86400 },
  { id: "fifty_hours", title: "Terminal Legend", desc: "50 hours of terminal time", icon: "🏆", req: (s) => s.totalSeconds >= 180000 },
  { id: "hundred_hours", title: "Centurion", desc: "100 hours of terminal time", icon: "💎", req: (s) => s.totalSeconds >= 360000 },
  { id: "streak_3", title: "Consistent Coder", desc: "3-day streak", icon: "📅", req: (s) => s.currentStreak >= 3 },
  { id: "streak_7", title: "Week Warrior", desc: "7-day streak", icon: "🗓️", req: (s) => s.currentStreak >= 7 },
  { id: "streak_30", title: "Monthly Master", desc: "30-day streak", icon: "🌟", req: (s) => s.currentStreak >= 30 },
  { id: "level_5", title: "Leveling Up", desc: "Reach level 5", icon: "🎮", req: (s) => s.level >= 5 },
  { id: "level_10", title: "Double Digits", desc: "Reach level 10", icon: "🎯", req: (s) => s.level >= 10 },
  { id: "level_25", title: "Quarter Century", desc: "Reach level 25", icon: "👑", req: (s) => s.level >= 25 },
  { id: "ai_first", title: "AI Apprentice", desc: "First minute with an AI coding tool", icon: "🤖", req: (s) => s.aiSeconds >= 60 },
  { id: "ai_one_hour", title: "Pair Programmer", desc: "1 hour of AI-assisted coding", icon: "🧠", req: (s) => s.aiSeconds >= 3600 },
  { id: "ai_ten_hours", title: "AI Whisperer", desc: "10 hours of AI-assisted coding", icon: "🔮", req: (s) => s.aiSeconds >= 36000 },
  { id: "ai_fifty_hours", title: "Vibe Coder", desc: "50 hours of AI-assisted coding", icon: "🎵", req: (s) => s.aiSeconds >= 180000 },
  { id: "commits_10", title: "Ship It", desc: "10 total git commits", icon: "🚀", req: (s) => s.totalCommits >= 10 },
  { id: "commits_100", title: "Commit Machine", desc: "100 total git commits", icon: "⚙️", req: (s) => s.totalCommits >= 100 },
  { id: "projects_3", title: "Multi-Tasker", desc: "Work on 3 different projects", icon: "📂", req: (s) => s.projectCount >= 3 },
  { id: "projects_10", title: "Portfolio Builder", desc: "Work on 10 different projects", icon: "🏗️", req: (s) => s.projectCount >= 10 },
];

function checkAchievements() {
  const unlocked = [...memoryState.achievements];
  const state = {
    totalSeconds: memoryState.totalSeconds,
    currentStreak: memoryState.currentStreak,
    level: memoryState.level,
    aiSeconds: memoryState.aiSeconds,
    totalCommits: memoryState.totalCommits,
    projectCount: Object.keys(memoryState.projectSeconds).length,
  };
  const newlyUnlocked = [];
  for (const ach of ACHIEVEMENT_DEFS) {
    if (!unlocked.includes(ach.id) && ach.req(state)) {
      unlocked.push(ach.id);
      newlyUnlocked.push(ach);
    }
  }
  memoryState.achievements = unlocked;
  memoryState.dirty = true;
  statsCacheDirty = true;
  return newlyUnlocked;
}

// ─── MAIN TRACKING LOOP ───

async function trackLoop() {
  try {
    // Edge case #3: Midnight rollover — detect date change
    const currentDate = getTodayKey();
    if (lastDateKey && lastDateKey !== currentDate) {
      console.log(`Date changed: ${lastDateKey} → ${currentDate}`);
      endCurrentSession();
      calculateStreak();
      flushMemoryToStore();
      autoBackupToICloud();
    }
    lastDateKey = currentDate;

    const active = await checkTerminalActive();
    const idleSeconds = await getSystemIdleSeconds();
    const isUserActive = idleSeconds < IDLE_THRESHOLD_SECONDS;

    // Terminal must be running AND user must be active (keyboard/mouse within last 2 min)
    const shouldTrack = active && isUserActive;

    if (shouldTrack && !isTerminalActive) {
      isTerminalActive = true;
      sessionStart = Date.now();
      consecutiveIdleSeconds = 0;
      if (!currentSession) startNewSession();
    } else if (!shouldTrack && isTerminalActive) {
      isTerminalActive = false;
      sessionStart = null;
    }

    // Track consecutive idle time for session ending (15 min)
    // Scale by TRACK_INTERVAL_SECONDS since loop runs every N seconds
    if (!isUserActive || !active) {
      consecutiveIdleSeconds += TRACK_INTERVAL_SECONDS;
      if (currentSession && consecutiveIdleSeconds >= SESSION_END_IDLE_SECONDS) {
        endCurrentSession();
      }
    } else {
      consecutiveIdleSeconds = 0;
    }

    if (isTerminalActive) {
      // Add TRACK_INTERVAL_SECONDS instead of 1
      memoryState.totalSeconds += TRACK_INTERVAL_SECONDS;
      updateDailyData(TRACK_INTERVAL_SECONDS);
      trackTickCounter += TRACK_INTERVAL_SECONDS;

      // AI tools: check every AI_CHECK_INTERVAL seconds via single process scan
      if (trackTickCounter % AI_CHECK_INTERVAL < TRACK_INTERVAL_SECONDS) {
        const lines = await scanProcesses();
        const aiResult = detectAIToolsFromLines(lines);
        if (aiResult.isAI) {
          updateAIData(AI_CHECK_INTERVAL);
          if (currentSession) currentSession.aiSeconds += AI_CHECK_INTERVAL;
        }
        memoryState.activeTools = aiResult.tools;
        statsCacheDirty = true;

        // Dev tools: check every DEV_TOOL_CHECK_INTERVAL (reuse same process lines)
        if (trackTickCounter % DEV_TOOL_CHECK_INTERVAL < TRACK_INTERVAL_SECONDS) {
          const devTools = detectDevToolsFromLines(lines);
          if (devTools.length > 0) updateToolData(devTools, DEV_TOOL_CHECK_INTERVAL);
        }
      }

      // Update current session
      if (currentSession) {
        currentSession.seconds += TRACK_INTERVAL_SECONDS;
        if (memoryState.activeTools.length > 0) {
          for (const t of memoryState.activeTools) currentSession.tools.add(t);
        }
      }

      // Project detection: every PROJECT_CHECK_INTERVAL
      if (trackTickCounter % PROJECT_CHECK_INTERVAL < TRACK_INTERVAL_SECONDS) {
        const project = await detectCurrentProject();
        if (project) updateProjectData(project, PROJECT_CHECK_INTERVAL);
      }

      // Commit counting: every COMMIT_CHECK_INTERVAL (5 min)
      if (trackTickCounter % COMMIT_CHECK_INTERVAL < TRACK_INTERVAL_SECONDS) {
        const commits = await countTodayCommits();
        const key = getTodayKey();
        memoryState.dailyCommits[key] = commits;
        memoryState.totalCommits = Object.values(memoryState.dailyCommits).reduce((a, b) => a + b, 0);
        memoryState.dirty = true;
        statsCacheDirty = true;
      }

      // Streak + level: only recalculate every 60s
      if (trackTickCounter % 60 < TRACK_INTERVAL_SECONDS) {
        calculateStreak();
        calculateLevel();
      }

      const newAchievements = checkAchievements();

      sendToRenderer("update", getStats());
      for (const ach of newAchievements) sendToRenderer("achievement-unlocked", ach);
    }
  } catch (err) {
    console.error("Track loop error:", err.message);
  }
}

// Edge case #6: Send updates when idle so UI is always current (every 30s)
function idleUpdate() {
  sendToRenderer("update", getStats());
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// Cached achievement defs — never changes at runtime
const ACHIEVEMENT_DEFS_SERIALIZED = ACHIEVEMENT_DEFS.map(({ id, title, desc, icon }) => ({ id, title, desc, icon }));

function getStats() {
  // Return cached stats if nothing changed (saves array rebuilds)
  if (cachedStats && !statsCacheDirty) {
    // Only update volatile fields
    cachedStats.isActive = isTerminalActive;
    cachedStats.currentSessionSeconds = currentSession ? currentSession.seconds : 0;
    cachedStats.currentSessionAiSeconds = currentSession ? currentSession.aiSeconds : 0;
    cachedStats.currentSessionTools = currentSession ? [...currentSession.tools] : [];
    return cachedStats;
  }

  const daily = memoryState.dailyData;
  const dailyAi = memoryState.dailyAiData;
  const todayKey = getTodayKey();
  const sessions = memoryState.sessions;

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split("T")[0];
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    last7.push({ day: dayNames[d.getDay()], date: key, seconds: daily[key] || 0, aiSeconds: dailyAi[key] || 0 });
  }

  const heatmap = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split("T")[0];
    heatmap.push({ date: key, seconds: daily[key] || 0 });
  }

  cachedStats = {
    totalSeconds: memoryState.totalSeconds,
    todaySeconds: daily[todayKey] || 0,
    currentStreak: memoryState.currentStreak,
    longestStreak: memoryState.longestStreak,
    level: memoryState.level,
    xp: memoryState.xp,
    xpToNext: 1000 - (memoryState.xp % 1000),
    xpProgress: (memoryState.xp % 1000) / 1000,
    isActive: isTerminalActive,
    aiSeconds: memoryState.aiSeconds,
    todayAiSeconds: dailyAi[todayKey] || 0,
    activeTools: memoryState.activeTools,
    projectCount: Object.keys(memoryState.projectSeconds).length,
    todayCommits: memoryState.dailyCommits[todayKey] || 0,
    totalCommits: memoryState.totalCommits,
    last7, heatmap,
    achievements: memoryState.achievements,
    achievementDefs: ACHIEVEMENT_DEFS_SERIALIZED,
    idleThreshold: IDLE_THRESHOLD_SECONDS,
    currentSessionSeconds: currentSession ? currentSession.seconds : 0,
    currentSessionAiSeconds: currentSession ? currentSession.aiSeconds : 0,
    currentSessionTools: currentSession ? [...currentSession.tools] : [],
    todaySessions: (sessions[todayKey] || []).length + (currentSession ? 1 : 0),
    todaySessionList: [
      ...(sessions[todayKey] || []),
      ...(currentSession && currentSession.seconds >= 10 ? [{
        startTime: currentSession.startTime,
        endTime: null,
        seconds: currentSession.seconds,
        aiSeconds: currentSession.aiSeconds,
        tools: [...currentSession.tools],
        active: true,
      }] : []),
    ],
    bestSessionSeconds: memoryState.bestSessionSeconds,
  };
  statsCacheDirty = false;
  return cachedStats;
}

// ─── WINDOW & TRAY ───

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520, height: 860, resizable: true,
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window", visualEffectState: "active",
    backgroundColor: "#00000000", transparent: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadFile("index.html");
  mainWindow.on("closed", () => (mainWindow = null));

  // Don't steal focus from the terminal on launch
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Edge case #6: Send stats as soon as window loads
  mainWindow.webContents.on("did-finish-load", () => {
    sendToRenderer("update", getStats());
  });
}

async function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADlSURBVDiNpZMxCsJAEEX/JCYS0oiVjb2n8BjeychewMrCRrDxCN7CQhBEBGsDIUSzFtnF3bgbPwzs8P7szuwsRITIYI0dTjjdmrxYADCjU0lELDTjBwBiSmJZAKmqS+ABIGXaJwq84JYyXBMRHOSEHgBMrQBQBgBmKkJtdO0A4FuGq42uBUb5N4DlAcAhz1RE3wrYKPQCRr8ALYL3AMAsNXor0cRw7T6dAGCHMx/AAAYZn8sAgErBJ6pqOJa1Y+MBf3MnSaYAagowIxFDxJGxYjONvN3kHF1JGjajhfOfrxfhNUsFFFgC5gAAAABJRU5ErkJggg=="
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("TerminalPulse");

  const isEnabled = await autoLauncher.isEnabled().catch(() => false);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Open TerminalPulse", click: () => (mainWindow ? mainWindow.show() : createWindow()) },
    { type: "separator" },
    { label: "Launch at Login", type: "checkbox", checked: isEnabled,
      click: (m) => { if (m.checked) autoLauncher.enable().catch(() => {}); else autoLauncher.disable().catch(() => {}); }
    },
    { type: "separator" },
    { label: "Backup Now to iCloud", click: () => {
      const ok = autoBackupToICloud();
      sendToRenderer("backup-status", ok ? "✅ Backed up to iCloud" : "❌ iCloud not available");
    }},
    { label: "Export Backup...", click: () => exportBackup() },
    { label: "Import Backup...", click: () => {
      const result = importBackup();
      sendToRenderer("backup-status", result.message);
    }},
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("click", () => (mainWindow ? mainWindow.show() : createWindow()));
}

function saveAndCleanup() {
  if (isTerminalActive) { isTerminalActive = false; sessionStart = null; }
  endCurrentSession();
  if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
  if (idleUpdateInterval) { clearInterval(idleUpdateInterval); idleUpdateInterval = null; }
  if (storeFlushInterval) { clearInterval(storeFlushInterval); storeFlushInterval = null; }
  flushMemoryToStore(); // Ensure all in-memory data is persisted
  autoBackupToICloud();
}

// ─── APP LIFECYCLE ───

app.whenReady().then(() => {
  // Edge case #3: Initialize date tracking
  lastDateKey = getTodayKey();

  createWindow();
  createTray();

  // Main tracking loop — every 5 seconds instead of 1 (5x fewer process spawns)
  trackingInterval = setInterval(trackLoop, TRACK_INTERVAL_SECONDS * 1000);
  trackLoop();

  // Send UI updates every 30s when idle (was 5s)
  idleUpdateInterval = setInterval(idleUpdate, IDLE_UPDATE_INTERVAL);

  // Flush in-memory state to disk every 30s (batches 6+ store.set() calls into 1 write)
  storeFlushInterval = setInterval(flushMemoryToStore, STORE_FLUSH_INTERVAL);

  // Backup every 5 minutes (was 1 min)
  startAutoBackup();

  // Auto-launch consent
  if (!store.get("autoLaunchConfigured")) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question", buttons: ["Yes", "No"], defaultId: 0,
      title: "TerminalPulse",
      message: "Would you like TerminalPulse to start automatically when you log in?",
    });
    if (choice === 0) autoLauncher.enable().catch(() => {});
    store.set("autoLaunchConfigured", true);
  }

  // Edge case #5: Resume from sleep — immediately refresh UI and recalculate
  powerMonitor.on("shutdown", () => { saveAndCleanup(); app.quit(); });
  powerMonitor.on("suspend", () => {
    if (isTerminalActive) { isTerminalActive = false; sessionStart = null; }
    endCurrentSession();
    flushMemoryToStore(); // Persist before sleep
    autoBackupToICloud();
  });
  powerMonitor.on("resume", () => {
    // Immediately recalculate in case we slept through midnight
    const newDate = getTodayKey();
    if (lastDateKey !== newDate) {
      console.log(`Woke up on new day: ${lastDateKey} → ${newDate}`);
      lastDateKey = newDate;
      calculateStreak();
    }
    // Push fresh stats to UI immediately
    sendToRenderer("update", getStats());
  });
});

// Edge case #7: If second instance tries to launch, focus the existing window
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

ipcMain.handle("get-stats", () => getStats());
ipcMain.handle("export-backup", () => exportBackup());
ipcMain.handle("import-backup", () => importBackup());
ipcMain.handle("get-backup-status", () => {
  const icloudBase = path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs");
  const icloudEnabled = fs.existsSync(icloudBase);
  const backupFile = path.join(ICLOUD_PATH, "terminalpulse-backup.enc");
  const lastBackup = fs.existsSync(backupFile) ? fs.statSync(backupFile).mtime.toISOString() : null;
  return { icloudEnabled, lastBackup };
});

app.on("window-all-closed", () => {});
app.on("activate", () => { if (!mainWindow) createWindow(); });
app.on("before-quit", () => { saveAndCleanup(); });
