const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen } = require('electron')
const path = require('path')
const { execSync, spawn } = require('child_process')
const fs = require('fs')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let tray = null
let floatingWin = null
let settingsWin = null
let historyWin = null
let speechProcess = null  // native Swift speech process

const historyFile = path.join(app.getPath('userData'), 'history.json')
const settingsFile = path.join(app.getPath('userData'), 'settings.json')

// ─── Uygulama Başlangıcı ─────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.dock.hide()
  createTray()
  registerHotkey()
})

app.on('window-all-closed', (e) => e.preventDefault())

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray() {
  // 1x1 şeffaf PNG — macOS Tray bir görüntü ister
  const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const icon = nativeImage.createFromDataURL(BLANK)
  tray = new Tray(icon)
  tray.setTitle('🎙')          // her macOS sürümünde çalışır
  tray.setToolTip('Murmur — Sesli Dikte  |  ⌥Space')
  buildTrayMenu()
  tray.on('click', () => tray.popUpContextMenu())
}

function buildTrayMenu(isListening = false) {
  const s = loadSettings()
  const langLabels = { auto: 'Otomatik', tr: 'Türkçe', en: 'İngilizce' }

  const menu = Menu.buildFromTemplate([
    {
      label: isListening ? '⏹  Durdur' : '🎙  Dikte Et',
      accelerator: 'Option+Space',
      click: toggleDictation
    },
    { type: 'separator' },
    {
      label: `Dil: ${langLabels[s.language] || 'Otomatik'}`,
      submenu: [
        { label: 'Otomatik',    type: 'radio', checked: s.language === 'auto', click: () => saveSetting('language', 'auto') },
        { label: '🇹🇷 Türkçe',   type: 'radio', checked: s.language === 'tr',   click: () => saveSetting('language', 'tr')   },
        { label: '🇬🇧 İngilizce',type: 'radio', checked: s.language === 'en',   click: () => saveSetting('language', 'en')   },
      ]
    },
    { type: 'separator' },
    { label: '📋  Geçmiş',  click: openHistory  },
    { label: '⚙️  Ayarlar', click: openSettings },
    { type: 'separator' },
    { label: 'Çıkış', role: 'quit' }
  ])

  tray.setContextMenu(menu)
}

// ─── Global Kısayol ───────────────────────────────────────────────────────────

function registerHotkey() {
  const s = loadSettings()
  globalShortcut.unregisterAll()
  try {
    globalShortcut.register(s.hotkey || 'Option+Space', toggleDictation)
  } catch {
    globalShortcut.register('Option+Space', toggleDictation)
  }
}

// ─── Dikte ───────────────────────────────────────────────────────────────────

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
  tray.setTitle('🎙●')
  // Ses tanıma artık floating.html içinde Deepgram WebSocket üzerinden yapılıyor
}

function stopDictation() {
  if (speechProcess) { speechProcess.kill('SIGTERM'); speechProcess = null }
  if (floatingWin && !floatingWin.isDestroyed()) {
    floatingWin.webContents.send('stop-recognition')
    setTimeout(() => {
      if (floatingWin && !floatingWin.isDestroyed()) floatingWin.close()
    }, 150)
  }
  buildTrayMenu(false)
  tray.setTitle('🎙')
}

// Komutları main process'te de işle (Swift output için)
function processCommandsMain(text, lang) {
  const TR = { 'nokta':'.','virgül':',','soru işareti':'?','ünlem':'!',
               'iki nokta':':','noktalı virgül':';','yeni satır':'\n','yeni paragraf':'\n\n','tire':'-' }
  const EN = { 'period':'.','comma':',','question mark':'?','exclamation':'!',
               'colon':':','semicolon':';','new line':'\n','new paragraph':'\n\n','dash':'-' }
  const cmds = lang.startsWith('tr') ? TR : EN
  let r = text
  for (const [w, s] of Object.entries(cmds))
    r = r.replace(new RegExp(`\\b${w}\\b`, 'gi'), s)
  r = r.replace(/başlık yaz (.+)/i, '# $1')
  r = r.replace(/heading (.+)/i, '# $1')
  r = r.replace(/büyük harf (\w+)/gi, (_, w) => w.toUpperCase())
  return r
}

// ─── Floating Panel ───────────────────────────────────────────────────────────

function createFloatingWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  floatingWin = new BrowserWindow({
    width: 320,
    height: 82,
    x: Math.round((width - 320) / 2),
    y: height - 110,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,   // odak çalma! orijinal uygulama odakta kalmalı
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    }
  })

  floatingWin.loadFile('src/floating.html')
  floatingWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  floatingWin.setAlwaysOnTop(true, 'screen-saver')
  // NOT: focus() çağrılmıyor — orijinal uygulama odakta kalmalı

  floatingWin.on('closed', () => {
    floatingWin = null
    buildTrayMenu(false)
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
    icon.setTemplateImage(true)
    tray.setImage(icon)
    tray.setTitle('🎙')
  })
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

ipcMain.on('dictation-result', (_, text) => {
  if (!text?.trim()) return
  stopDictation()
  // Floating pencere kapanınca orijinal uygulama odak alır.
  // 600ms bekleyerek o geçişin tamamlanmasını sağlıyoruz.
  setTimeout(() => {
    typeText(text)
    saveHistory(text)
  }, 600)
})

ipcMain.on('dictation-cancel', () => stopDictation())

// Deepgram'dan gelen kelimeler — anında yaz, oturum açık kalır
ipcMain.on('stream-text', (_, text) => {
  if (!text?.trim()) return
  const s = loadSettings()
  const lang = { auto: 'tr', tr: 'tr', en: 'en' }[s.language] || 'tr'
  const processed = processCommandsMain(text.trim(), lang)
  typeText(processed + ' ')
  saveHistory(processed)
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

ipcMain.on('clear-history', () => fs.writeFileSync(historyFile, JSON.stringify([])))

// ─── Metin Yazma ─────────────────────────────────────────────────────────────

function typeText(text) {
  // Tırnak ve özel karakterleri escape et
  const safe = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')

  try {
    // 1. Pano'ya yaz
    // 2. Ön plandaki uygulamayı aktifleştir (focus Electron'dan geri dönsün)
    // 3. Cmd+V ile yapıştır
    execSync(`osascript << 'APPLESCRIPT'
set the clipboard to "${safe}"
delay 0.2
tell application "System Events"
  keystroke "v" using {command down}
end tell
APPLESCRIPT`)
  } catch (e) {
    console.error('Yazma hatası:', e.message)
    // Fallback: sadece pano'ya koy
    try { execSync(`printf '%s' "${safe}" | pbcopy`) } catch {}
  }
}

// ─── Pencereler ───────────────────────────────────────────────────────────────

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    app.dock.show()
    app.focus({ steal: true })
    return
  }
  settingsWin = new BrowserWindow({
    width: 500, height: 400,
    title: 'Murmur — Ayarlar',
    titleBarStyle: 'hiddenInset',
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  settingsWin.loadFile('src/settings.html')
  app.dock.show()
  setTimeout(() => app.focus({ steal: true }), 100)
  settingsWin.on('closed', () => app.dock.hide())
}

function openHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.focus()
    app.dock.show()
    app.focus({ steal: true })
    return
  }
  historyWin = new BrowserWindow({
    width: 540, height: 520,
    title: 'Murmur — Geçmiş',
    titleBarStyle: 'hiddenInset',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  historyWin.loadFile('src/history.html')
  app.dock.show()
  setTimeout(() => app.focus({ steal: true }), 100)
  historyWin.on('closed', () => app.dock.hide())
}

// ─── Ayarlar & Geçmiş ────────────────────────────────────────────────────────

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }
  catch { return { language: 'auto', hotkey: 'Option+Space' } }
}

function saveSetting(key, value) {
  const s = loadSettings()
  s[key] = value
  fs.writeFileSync(settingsFile, JSON.stringify(s))
  buildTrayMenu()
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(historyFile, 'utf8')) }
  catch { return [] }
}

function saveHistory(text) {
  const h = loadHistory()
  h.unshift({ id: Date.now(), text, date: new Date().toISOString() })
  fs.writeFileSync(historyFile, JSON.stringify(h.slice(0, 200)))
}

// ─── İkon (artık kullanılmıyor, PNG dosyadan yükleniyor) ─────────────────────
// Eski SVG yöntemi kaldırıldı
