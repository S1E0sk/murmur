const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen } = require('electron')
const path = require('path')
const { execSync } = require('child_process')
const fs = require('fs')

let tray = null
let floatingWin = null
let settingsWin = null
let historyWin = null

// Geçmiş dosyası
const historyFile = path.join(app.getPath('userData'), 'history.json')

// ─── Uygulama Başlangıcı ─────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.dock.hide() // Dock'ta görünme

  createTray()
  registerHotkey()
})

app.on('window-all-closed', (e) => {
  e.preventDefault() // Tüm pencereler kapanınca uygulamayı kapatma
})

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray() {
  // Basit mikrofon ikonu (template image — dark/light mode uyumlu)
  const icon = nativeImage.createFromDataURL(getMicIcon())
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Murmur')
  buildTrayMenu()
}

function buildTrayMenu(isListening = false) {
  const settings = loadSettings()
  const langLabel = { auto: 'Otomatik', tr: 'Türkçe', en: 'İngilizce' }

  const menu = Menu.buildFromTemplate([
    {
      label: isListening ? '⏹  Durdur' : '🎙  Dikte Et',
      accelerator: 'Option+Space',
      click: toggleDictation
    },
    { type: 'separator' },
    {
      label: `Dil: ${langLabel[settings.language]}`,
      submenu: [
        { label: 'Otomatik', type: 'radio', checked: settings.language === 'auto', click: () => saveSetting('language', 'auto') },
        { label: '🇹🇷 Türkçe', type: 'radio', checked: settings.language === 'tr',   click: () => saveSetting('language', 'tr')   },
        { label: '🇬🇧 İngilizce', type: 'radio', checked: settings.language === 'en', click: () => saveSetting('language', 'en')  },
      ]
    },
    { type: 'separator' },
    { label: 'Geçmiş',  click: openHistory  },
    { label: 'Ayarlar', click: openSettings },
    { type: 'separator' },
    { label: 'Çıkış', role: 'quit' }
  ])

  tray.setContextMenu(menu)
}

// ─── Global Kısayol ───────────────────────────────────────────────────────────

function registerHotkey() {
  const settings = loadSettings()
  const hotkey = settings.hotkey || 'Option+Space'

  globalShortcut.unregisterAll()
  globalShortcut.register(hotkey, toggleDictation)
}

// ─── Dikte Mantığı ───────────────────────────────────────────────────────────

function toggleDictation() {
  if (floatingWin && !floatingWin.isDestroyed()) {
    stopDictation()
  } else {
    startDictation()
  }
}

function startDictation() {
  createFloatingWindow()
  buildTrayMenu(true)
  updateTrayIcon(true)
}

function stopDictation() {
  if (floatingWin && !floatingWin.isDestroyed()) {
    floatingWin.close()
    floatingWin = null
  }
  buildTrayMenu(false)
  updateTrayIcon(false)
}

function updateTrayIcon(listening) {
  const icon = nativeImage.createFromDataURL(getMicIcon(listening))
  icon.setTemplateImage(!listening)
  tray.setImage(icon)
}

// ─── Floating Pencere ─────────────────────────────────────────────────────────

function createFloatingWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  floatingWin = new BrowserWindow({
    width: 300,
    height: 80,
    x: Math.round((width - 300) / 2),
    y: height - 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  // Mikrofon iznini otomatik ver
  floatingWin.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      callback(true)
    } else {
      callback(false)
    }
  })

  floatingWin.loadFile('src/floating.html')
  floatingWin.setVisibleOnAllWorkspaces(true)
  floatingWin.focus()

  floatingWin.on('closed', () => {
    floatingWin = null
    buildTrayMenu(false)
    updateTrayIcon(false)
  })
}

// ─── IPC — Renderer'dan gelen mesajlar ───────────────────────────────────────

// Dikte metni hazır → aktif uygulamaya yaz
ipcMain.on('dictation-result', (_, text) => {
  if (!text || !text.trim()) return

  stopDictation()

  // Kısa gecikme — pencere kapandıktan sonra yaz
  setTimeout(() => {
    typeTextViaClipboard(text)
    saveHistory(text)
  }, 150)
})

ipcMain.on('dictation-cancel', () => {
  stopDictation()
})

ipcMain.handle('get-settings', () => loadSettings())
ipcMain.handle('get-history',  () => loadHistory())

ipcMain.on('save-setting', (_, key, value) => {
  saveSetting(key, value)
  if (key === 'hotkey') registerHotkey()
})

ipcMain.on('delete-history-item', (_, id) => {
  const h = loadHistory().filter(e => e.id !== id)
  fs.writeFileSync(historyFile, JSON.stringify(h))
})

ipcMain.on('clear-history', () => {
  fs.writeFileSync(historyFile, JSON.stringify([]))
})

// ─── Metin Yazma ─────────────────────────────────────────────────────────────

function typeTextViaClipboard(text) {
  // AppleScript ile pano üzerinden yapıştır
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  try {
    execSync(`osascript -e '
      set the clipboard to "${escaped}"
      tell application "System Events"
        keystroke "v" using command down
      end tell
    '`)
  } catch (e) {
    console.error('Yazma hatası:', e.message)
  }
}

// ─── Ayarlar & Geçmiş ─────────────────────────────────────────────────────────

const settingsFile = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch {
    return { language: 'auto', hotkey: 'Option+Space' }
  }
}

function saveSetting(key, value) {
  const s = loadSettings()
  s[key] = value
  fs.writeFileSync(settingsFile, JSON.stringify(s))
  buildTrayMenu()
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(historyFile, 'utf8'))
  } catch {
    return []
  }
}

function saveHistory(text) {
  const h = loadHistory()
  h.unshift({ id: Date.now(), text, date: new Date().toISOString() })
  fs.writeFileSync(historyFile, JSON.stringify(h.slice(0, 200)))
}

// ─── Pencereler ───────────────────────────────────────────────────────────────

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus(); return
  }
  settingsWin = new BrowserWindow({
    width: 500, height: 380,
    titleBarStyle: 'hiddenInset',
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  settingsWin.loadFile('src/settings.html')
  app.dock.show()
  settingsWin.on('closed', () => { app.dock.hide() })
}

function openHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.focus(); return
  }
  historyWin = new BrowserWindow({
    width: 540, height: 520,
    titleBarStyle: 'hiddenInset',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  historyWin.loadFile('src/history.html')
  app.dock.show()
  historyWin.on('closed', () => { app.dock.hide() })
}

// ─── İkon (SVG → Base64) ─────────────────────────────────────────────────────

function getMicIcon(active = false) {
  const color = active ? '%23FF3B30' : '%23000000'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="${color}"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm6.5 10.5A6.5 6.5 0 0 1 12 18a6.5 6.5 0 0 1-6.5-6.5H4A8 8 0 0 0 11 19.9V22h2v-2.1A8 8 0 0 0 20 11.5h-1.5z"/></svg>`
  return `data:image/svg+xml,${svg}`
}
