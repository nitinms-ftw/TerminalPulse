const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getStats: () => ipcRenderer.invoke("get-stats"),
  onUpdate: (cb) => ipcRenderer.on("update", (_, data) => cb(data)),
  onAchievement: (cb) => ipcRenderer.on("achievement-unlocked", (_, data) => cb(data)),
  // Backup
  exportBackup: () => ipcRenderer.invoke("export-backup"),
  importBackup: () => ipcRenderer.invoke("import-backup"),
  getBackupStatus: () => ipcRenderer.invoke("get-backup-status"),
  onBackupStatus: (cb) => ipcRenderer.on("backup-status", (_, msg) => cb(msg)),
});
