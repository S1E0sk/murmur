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
  const icon = nativeImage.createFromDataURL(getMicIconBase64(false))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Murmur — Sesli Dikte')
  buildTrayMenu()

  // Sol tık da menüyü açsın
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
  const s = loadSettings()
  const langCode = { auto: 'tr', tr: 'tr', en: 'en' }[s.language] || 'tr'

  createFloatingWindow()
  buildTrayMenu(true)
  tray.setImage(nativeImage.createFromDataURL(getMicIconBase64(true)))

  // Python + Whisper ile yerel ses tanıma
  const pyScript = path.join(__dirname, 'transcribe.py')
  speechProcess = spawn('python3', [pyScript, langCode, 'base'])

  speechProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n')
    for (const line of lines) {
      if (line.startsWith('INTERIM:')) {
        const text = line.slice(8)
        floatingWin?.webContents.send('interim-text', text)
      } else if (line.startsWith('FINAL:')) {
        const text = line.slice(6).trim()
        if (text) {
          const processed = processCommandsMain(text, langCode)
          stopDictation()
          setTimeout(() => {
            typeText(processed)
            saveHistory(processed)
          }, 200)
        } else {
          stopDictation()
        }
      } else if (line.startsWith('ERROR:')) {
        const errMsg = line.slice(6)
        floatingWin?.webContents.send('show-error', errMsg)
        setTimeout(() => stopDictation(), 2500)
      }
    }
  })

  speechProcess.stderr.on('data', (d) => {
    // Whisper model yüklenirken stderr'e yazar — ignore
    const msg = d.toString()
    if (msg.includes('Downloading') || msg.includes('Loading')) {
      floatingWin?.webContents.send('interim-text', 'Model yükleniyor...')
    }
  })

  speechProcess.on('close', () => { speechProcess = null })
  speechProcess.on('error', (e) => {
    floatingWin?.webContents.send('show-error', 'Python bulunamadı')
    setTimeout(() => stopDictation(), 2000)
  })
}

function stopDictation() {
  // Swift process'i durdur
  if (speechProcess) {
    speechProcess.kill('SIGTERM')
    speechProcess = null
  }
  if (floatingWin && !floatingWin.isDestroyed()) {
    floatingWin.webContents.send('stop-recognition')
    setTimeout(() => {
      if (floatingWin && !floatingWin.isDestroyed()) floatingWin.close()
    }, 100)
  }
  buildTrayMenu(false)
  const icon = nativeImage.createFromDataURL(getMicIconBase64(false))
  icon.setTemplateImage(true)
  tray.setImage(icon)
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
    focusable: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Web Speech API için gerekli
      webSecurity: false,
    }
  })

  floatingWin.loadFile('src/floating.html')
  floatingWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  floatingWin.setAlwaysOnTop(true, 'screen-saver')

  // Kısa gecikme sonra focus ver — speech recognition için gerekli
  setTimeout(() => {
    if (floatingWin && !floatingWin.isDestroyed()) floatingWin.focus()
  }, 200)

  floatingWin.on('closed', () => {
    floatingWin = null
    buildTrayMenu(false)
    const icon = nativeImage.createFromDataURL(getMicIconBase64(false))
    icon.setTemplateImage(true)
    tray.setImage(icon)
  })
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

// Swift process kullandığımız için renderer'dan result gelmeyebilir
// ama yine de tutuyoruz (fallback için)
ipcMain.on('dictation-result', (_, text) => {
  if (!text?.trim()) return
  stopDictation()
  setTimeout(() => {
    typeText(text)
    saveHistory(text)
  }, 200)
})

ipcMain.on('dictation-cancel', () => stopDictation())

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
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  try {
    execSync(`osascript -e '
      set the clipboard to "${escaped}"
      tell application "System Events"
        keystroke "v" using {command down}
      end tell
    '`)
  } catch (e) {
    console.error('Yazma hatası:', e.message)
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

// ─── İkon ────────────────────────────────────────────────────────────────────

function getMicIconBase64(active = false) {
  const fill = active ? '%23FF3B30' : '%23000000'
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='${fill}'><path d='M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm6.5 10.5A6.5 6.5 0 0 1 12 18a6.5 6.5 0 0 1-6.5-6.5H4A8 8 0 0 0 11 19.9V22h2v-2.1A8 8 0 0 0 20 11.5h-1.5z'/></svg>`
  return `data:image/svg+xml,${svg}`
}
