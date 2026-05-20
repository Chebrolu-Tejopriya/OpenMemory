import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

type StoreData = { x?: number; y?: number }

function getStorePath() {
  return join(app.getPath('userData'), 'openMemory-prefs.json')
}

function loadStore(): StoreData {
  try {
    if (existsSync(getStorePath())) {
      return JSON.parse(readFileSync(getStorePath(), 'utf-8'))
    }
  } catch {}
  return {}
}

function saveStore(data: StoreData) {
  try { writeFileSync(getStorePath(), JSON.stringify(data), 'utf-8') } catch {}
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const prefs = loadStore()
  const x = prefs.x ?? width - 340
  const y = prefs.y ?? 40

  win = new BrowserWindow({
    width: 320,
    height: 600,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('moved', () => {
    if (!win) return
    const [px, py] = win.getPosition()
    saveStore({ x: px, y: py })
  })

  win.on('blur', () => {
    win?.setAlwaysOnTop(true, 'floating')
  })

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray() {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('OpenMemory Notes')

  const updateMenu = () => {
    const visible = win?.isVisible() ?? false
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? 'Hide Notes' : 'Show Notes',
        click: () => {
          if (win?.isVisible()) win.hide()
          else win?.show()
          updateMenu()
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
    ])
    tray?.setContextMenu(menu)
  }

  updateMenu()
  tray.on('click', () => {
    if (win?.isVisible()) win.hide()
    else win?.show()
    updateMenu()
  })
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide()
  createWindow()
  createTray()
})

app.on('before-quit', () => { isQuitting = true })
app.on('window-all-closed', () => { if (isQuitting) app.quit() })

ipcMain.handle('set-ignore-mouse', (_e, ignore: boolean) => {
  win?.setIgnoreMouseEvents(ignore, { forward: true })
})
ipcMain.handle('close-window', () => win?.hide())
ipcMain.handle('open-webapp', () => { shell.openExternal('http://localhost:3002') })
