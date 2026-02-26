const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, powerMonitor, dialog } = require("electron");
const path = require("path");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const Store = require("electron-store");
const AutoLaunch = require("auto-launch");

// ─── FIX #3: Encrypted store ───
const ENCRYPTION_KEY = "tp-" + os.hostname() + "-" + os.userInfo().username;
const store = new Store({ encryptionKey: ENCRYPTION_KEY });

// ─── FIX #4: Encrypted backups ───
const BACKUP_ALGO = "aes-256-gcm";
const BACKUP_KEY_SEED = "TerminalPulse-backup-" + os.userInfo().username;

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

// ─── FIX #5: Whitelist allowed keys for backup import ───
const ALLOWED_STORE_KEYS = new Set([
  "totalSeconds", "dailyData", "achievements", "currentStreak", "longestStreak",
  "level", "xp", "aiSeconds", "dailyAiData", "toolSeconds", "dailyToolData",
  "projectSeconds", "dailyProjectData", "todayCommits", "totalCommits",
  "dailyCommits", "activeTools", "autoLaunchConfigured",
]);

function validateBackupData(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const clean = {};
  for (const [key, val] of Object.entries(data)) {
    if (!ALLOWED_STORE_KEYS.has(key)) continue;
    // Type validation
    if (key === "totalSeconds" || key === "currentStreak" || key === "longestStreak" ||
        key === "level" || key === "xp" || key === "aiSeconds" ||
        key === "todayCommits" || key === "totalCommits") {
      if (typeof val !== "number" || val < 0) continue;
    }
    if (key === "achievements") {
      if (!Array.isArray(val)) continue;
      if (!val.every(v => typeof v === "string" && v.length < 50)) continue;
    }
    if (key === "dailyData" || key === "dailyAiData" || key === "dailyCommits") {
      if (typeof val !== "object" || val === null) continue;
      // Validate date keys and numeric values
      const valid = Object.entries(val).every(([k, v]) =>
        /^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === "number" && v >= 0
      );
      if (!valid) continue;
    }
    if (key === "activeTools") {
      if (!Array.isArray(val)) continue;
      if (!val.every(v => typeof v === "string" && v.length < 100)) continue;
    }
    clean[key] = val;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

// ─── BACKUP SYSTEM ───
const ICLOUD_PATH = path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/TerminalPulse");
let backupInterval;

function getBackupData() {
  const data = {};
  for (const key of ALLOWED_STORE_KEYS) {
    const val = store.get(key);
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

    // Weekly snapshot
    const weekKey = new Date().toISOString().split("T")[0];
    const weeklyFile = path.join(ICLOUD_PATH, `terminalpulse-backup-${weekKey}.enc`);
    if (!fs.existsSync(weeklyFile)) {
      fs.writeFileSync(weeklyFile, encryptData(getBackupData()), "utf-8");
      // Clean old snapshots (keep last 8)
      const files = fs.readdirSync(ICLOUD_PATH)
        .filter(f => f.startsWith("terminalpulse-backup-") && f.endsWith(".enc"))
        .sort()
        .reverse();
      for (const old of files.slice(8)) {
        fs.unlinkSync(path.join(ICLOUD_PATH, old));
      }
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
      if (!validated) {
        return { success: false, message: "Invalid or corrupted backup data" };
      }
      for (const [key, val] of Object.entries(validated)) {
        store.set(key, val);
      }
      const hours = Math.round((validated.totalSeconds || 0) / 3600);
      return { success: true, message: `Restored ${hours}h of data` };
    } catch (err) {
      return { success: false, message: "Failed to decrypt — wrong machine or corrupted file" };
    }
  }
  return { success: false, message: "No file selected" };
}

function startAutoBackup() {
  autoBackupToICloud();
  backupInterval = setInterval(autoBackupToICloud, 5 * 60 * 1000);
}

// Auto-launch setup
const autoLauncher = new AutoLaunch({
  name: "TerminalPulse",
  path: app.getPath("exe"),
  isHidden: true,
});

let mainWindow;
let tray;
let trackingInterval;
let isTerminalActive = false;
let sessionStart = null;

// Initialize store defaults
const defaults = {
  totalSeconds: 0,
  dailyData: {},
  achievements: [],
  currentStreak: 0,
  longestStreak: 0,
  level: 1,
  xp: 0,
  aiSeconds: 0,
  dailyAiData: {},
  toolSeconds: {},
  dailyToolData: {},
  projectSeconds: {},
  dailyProjectData: {},
  todayCommits: 0,
  totalCommits: 0,
  dailyCommits: {},
  activeTools: [],
};
for (const [key, val] of Object.entries(defaults)) {
  if (store.get(key) === undefined) store.set(key, val);
}

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

// ─── FIX #1: All exec() replaced with execFile() — no shell injection ───

function checkTerminalActive() {
  return new Promise((resolve) => {
    const script =
      'tell application "System Events" to set frontApp to name of first application process whose frontmost is true\nreturn frontApp';
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) return resolve(false);
      const activeApp = stdout.trim().toLowerCase();
      const terminals = ["terminal", "iterm2", "iterm", "hyper", "alacritty", "kitty", "warp", "wezterm", "tabby"];
      resolve(terminals.some((t) => activeApp.includes(t)));
    });
  });
}

// ─── FIX #7: ps aux replaced with ps -eo command= (no user info leaked) ───
function detectAITools() {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "command="], (err, stdout) => {
      if (err) return resolve({ isAI: false, tools: [] });
      const lines = stdout.split("\n");
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
        if (lines.some((line) => tool.test(line.toLowerCase()))) {
          detected.push(tool.name);
        }
      }
      resolve({ isAI: detected.length > 0, tools: detected });
    });
  });
}

function detectDevTools() {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "command="], (err, stdout) => {
      if (err) return resolve([]);
      const lines = stdout.toLowerCase();
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
        if (tool.patterns.some((p) => lines.includes(p))) {
          detected.push(tool.name);
        }
      }
      resolve(detected);
    });
  });
}

// ─── FIX #9: Safer project detection — no shell interpolation ───
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
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const title = stdout.trim();
      const match = title.match(/[~\/][^\s]*/);
      if (match) {
        let dir = match[0].replace("~", os.homedir());
        resolve(getProjectName(dir));
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
      if (fs.existsSync(path.join(dir, ".git"))) {
        return path.basename(dir);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.basename(dirPath);
  } catch {
    return path.basename(dirPath);
  }
}

// ─── FIX #2: Shell history tracking completely removed ───
// (was a privacy risk — commands often contain secrets)

// ─── FIX #9: Git commit counting — safe, no shell interpolation ───
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

    execFile("find", [...searchDirs, "-maxdepth", "3", "-name", ".git", "-type", "d"], (err, stdout) => {
      if (err || !stdout.trim()) return resolve(0);
      const gitDirs = stdout.trim().split("\n").filter(Boolean);
      let totalCommits = 0;
      let pending = gitDirs.length;
      if (pending === 0) return resolve(0);

      for (const gitDir of gitDirs) {
        const repoDir = path.dirname(gitDir);
        // Get user name safely first, then count commits
        execFile("git", ["-C", repoDir, "config", "user.name"], (err1, userName) => {
          const author = (userName || "").trim();
          if (!author) { pending--; if (pending === 0) resolve(totalCommits); return; }
          execFile("git", ["-C", repoDir, "log", "--oneline", `--since=${today}`, `--author=${author}`], (err2, stdout2) => {
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
  const daily = store.get("dailyData") || {};
  daily[key] = (daily[key] || 0) + seconds;
  store.set("dailyData", daily);
}

function updateAIData(seconds) {
  const key = getTodayKey();
  store.set("aiSeconds", (store.get("aiSeconds") || 0) + seconds);
  const dailyAi = store.get("dailyAiData") || {};
  dailyAi[key] = (dailyAi[key] || 0) + seconds;
  store.set("dailyAiData", dailyAi);
}

function updateToolData(tools, seconds) {
  const key = getTodayKey();
  const toolSecs = store.get("toolSeconds") || {};
  const dailyTool = store.get("dailyToolData") || {};
  if (!dailyTool[key]) dailyTool[key] = {};
  for (const tool of tools) {
    toolSecs[tool] = (toolSecs[tool] || 0) + seconds;
    dailyTool[key][tool] = (dailyTool[key][tool] || 0) + seconds;
  }
  store.set("toolSeconds", toolSecs);
  store.set("dailyToolData", dailyTool);
}

function updateProjectData(project, seconds) {
  if (!project) return;
  const key = getTodayKey();
  const projSecs = store.get("projectSeconds") || {};
  const dailyProj = store.get("dailyProjectData") || {};
  if (!dailyProj[key]) dailyProj[key] = {};
  projSecs[project] = (projSecs[project] || 0) + seconds;
  dailyProj[key][project] = (dailyProj[key][project] || 0) + seconds;
  store.set("projectSeconds", projSecs);
  store.set("dailyProjectData", dailyProj);
}

function calculateStreak() {
  const daily = store.get("dailyData") || {};
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
  store.set("currentStreak", streak);
  if (streak > store.get("longestStreak")) store.set("longestStreak", streak);
}

function calculateLevel() {
  const totalMinutes = Math.floor(store.get("totalSeconds") / 60);
  const xp = totalMinutes * 10;
  const level = Math.floor(xp / 1000) + 1;
  store.set("xp", xp);
  store.set("level", level);
}

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
  const unlocked = store.get("achievements") || [];
  const projSecs = store.get("projectSeconds") || {};
  const state = {
    totalSeconds: store.get("totalSeconds"),
    currentStreak: store.get("currentStreak"),
    level: store.get("level"),
    aiSeconds: store.get("aiSeconds") || 0,
    totalCommits: store.get("totalCommits") || 0,
    projectCount: Object.keys(projSecs).length,
  };
  const newlyUnlocked = [];
  for (const ach of ACHIEVEMENT_DEFS) {
    if (!unlocked.includes(ach.id) && ach.req(state)) {
      unlocked.push(ach.id);
      newlyUnlocked.push(ach);
    }
  }
  store.set("achievements", unlocked);
  return newlyUnlocked;
}

// ─── MAIN TRACKING LOOP ───
async function trackLoop() {
  const active = await checkTerminalActive();

  if (active && !isTerminalActive) {
    isTerminalActive = true;
    sessionStart = Date.now();
  } else if (!active && isTerminalActive) {
    isTerminalActive = false;
    sessionStart = null;
  }

  if (isTerminalActive) {
    const total = store.get("totalSeconds") + 1;
    store.set("totalSeconds", total);
    updateDailyData(1);

    const aiResult = await detectAITools();
    if (aiResult.isAI) updateAIData(1);
    store.set("activeTools", aiResult.tools);

    if (total % 5 === 0) {
      const devTools = await detectDevTools();
      if (devTools.length > 0) updateToolData(devTools, 5);
    }

    if (total % 10 === 0) {
      const project = await detectCurrentProject();
      if (project) updateProjectData(project, 10);
    }

    if (total % 60 === 0) {
      const commits = await countTodayCommits();
      const key = getTodayKey();
      const dailyCommits = store.get("dailyCommits") || {};
      dailyCommits[key] = commits;
      store.set("dailyCommits", dailyCommits);
      const totalCommits = Object.values(dailyCommits).reduce((a, b) => a + b, 0);
      store.set("totalCommits", totalCommits);
    }

    calculateStreak();
    calculateLevel();
    const newAchievements = checkAchievements();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update", getStats());
      for (const ach of newAchievements) {
        mainWindow.webContents.send("achievement-unlocked", ach);
      }
    }
  }
}

function getStats() {
  const daily = store.get("dailyData") || {};
  const dailyAi = store.get("dailyAiData") || {};
  const todayKey = getTodayKey();
  const projSecs = store.get("projectSeconds") || {};
  const toolSecs = store.get("toolSeconds") || {};
  const dailyCommits = store.get("dailyCommits") || {};

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

  return {
    totalSeconds: store.get("totalSeconds"),
    todaySeconds: daily[todayKey] || 0,
    currentStreak: store.get("currentStreak"),
    longestStreak: store.get("longestStreak"),
    level: store.get("level"),
    xp: store.get("xp"),
    xpToNext: 1000 - (store.get("xp") % 1000),
    xpProgress: (store.get("xp") % 1000) / 1000,
    isActive: isTerminalActive,
    aiSeconds: store.get("aiSeconds") || 0,
    todayAiSeconds: dailyAi[todayKey] || 0,
    activeTools: store.get("activeTools") || [],
    projectCount: Object.keys(projSecs).length,
    todayCommits: dailyCommits[todayKey] || 0,
    totalCommits: store.get("totalCommits") || 0,
    last7,
    heatmap,
    achievements: store.get("achievements") || [],
    achievementDefs: ACHIEVEMENT_DEFS.map(({ id, title, desc, icon }) => ({ id, title, desc, icon })),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 860,
    resizable: true,
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("index.html");
  mainWindow.on("closed", () => (mainWindow = null));
}

async function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADlSURBVDiNpZMxCsJAEEX/JCYS0oiVjb2n8BjeychewMrCRrDxCN7CQhBEBGsDIUSzFtnF3bgbPwzs8P7szuwsRITIYI0dTjjdmrxYADCjU0lELDTjBwBiSmJZAKmqS+ABIGXaJwq84JYyXBMRHOSEHgBMrQBQBgBmKkJtdO0A4FuGq42uBUb5N4DlAcAhz1RE3wrYKPQCRr8ALYL3AMAsNXor0cRw7T6dAGCHMx/AAAYZn8sAgErBJ6pqOJa1Y+MBf3MnSaYAagowIxFDxJGxYjONvN3kHF1JGjajhfOfrxfhNUsFFFgC5gAAAABJRU5ErkJggg=="
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("TerminalPulse");

  // ─── FIX #10: Check auto-launch status, don't force enable ───
  const isEnabled = await autoLauncher.isEnabled().catch(() => false);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Open TerminalPulse", click: () => (mainWindow ? mainWindow.show() : createWindow()) },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: isEnabled,
      click: (menuItem) => {
        if (menuItem.checked) autoLauncher.enable().catch(() => {});
        else autoLauncher.disable().catch(() => {});
      },
    },
    { type: "separator" },
    { label: "Backup Now to iCloud", click: () => {
      const ok = autoBackupToICloud();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backup-status", ok ? "✅ Backed up to iCloud" : "❌ iCloud not available");
      }
    }},
    { label: "Export Backup...", click: () => exportBackup() },
    { label: "Import Backup...", click: () => {
      const result = importBackup();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backup-status", result.message);
      }
    }},
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("click", () => (mainWindow ? mainWindow.show() : createWindow()));
}

function saveAndCleanup() {
  if (isTerminalActive && sessionStart) {
    isTerminalActive = false;
    sessionStart = null;
  }
  if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
  autoBackupToICloud();
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  trackingInterval = setInterval(trackLoop, 1000);
  trackLoop();
  startAutoBackup();

  // ─── FIX #10: Ask before enabling auto-launch on first run ───
  if (!store.get("autoLaunchConfigured")) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      buttons: ["Yes", "No"],
      defaultId: 0,
      title: "TerminalPulse",
      message: "Would you like TerminalPulse to start automatically when you log in?",
    });
    if (choice === 0) {
      autoLauncher.enable().catch(() => {});
    }
    store.set("autoLaunchConfigured", true);
  }

  powerMonitor.on("shutdown", () => { saveAndCleanup(); app.quit(); });
  powerMonitor.on("suspend", () => { if (isTerminalActive) { isTerminalActive = false; sessionStart = null; } });
  powerMonitor.on("resume", () => {});
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
