import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const BACKEND_URL = process.env.BACKEND_URL || 'https://openmemory-backend-j775.onrender.com'
const POLL_INTERVAL = 8000

// ── Simple JSON store ─────────────────────────────────────────
type PinPositions = Record<string, { x: number; y: number }>

function getStorePath() {
  return join(app.getPath('userData'), 'openMemory-pins.json')
}
function loadPositions(): PinPositions {
  try {
    if (existsSync(getStorePath())) return JSON.parse(readFileSync(getStorePath(), 'utf-8'))
  } catch {}
  return {}
}
function savePositions(data: PinPositions) {
  try { writeFileSync(getStorePath(), JSON.stringify(data), 'utf-8') } catch {}
}

// ── State ─────────────────────────────────────────────────────
let tray: Tray | null = null
let isQuitting = false

// Map noteId → BrowserWindow
const noteWindows = new Map<string, BrowserWindow>()

type PinnedNote = {
  id: string
  title: string | null
  body: string | null
  color_bg: string
  color_text: string
  todos?: string | null
}

// ── Fetch pinned notes from backend ──────────────────────────
async function fetchPinned(): Promise<PinnedNote[]> {
  try {
    const res = await fetch(`${BACKEND_URL}/notes/pinned`)
    if (!res.ok) return []
    const data = await res.json()
    return data.notes || []
  } catch { return [] }
}

// ── Create a window for a single note ────────────────────────
function createNoteWindow(note: PinnedNote) {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const positions = loadPositions()
  const saved = positions[note.id]

  // Default position: stagger notes from top-right
  const offset = noteWindows.size * 30
  const x = saved?.x ?? width - 260 - offset
  const y = saved?.y ?? 80 + offset

  const win = new BrowserWindow({
    width: 240,
    height: 180,
    x,
    y,
    minWidth: 180,
    minHeight: 100,
    maxWidth: 400,
    maxHeight: 500,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('moved', () => {
    const [px, py] = win.getPosition()
    const positions = loadPositions()
    positions[note.id] = { x: px, y: py }
    savePositions(positions)
  })

  win.on('resized', () => {
    // Re-broadcast note data so renderer can re-fit
    win.webContents.send('note-data', note)
  })

  win.on('blur', () => win.setAlwaysOnTop(true, 'floating'))
  win.on('closed', () => noteWindows.delete(note.id))

  if (process.env.NODE_ENV === 'development') {
    win.loadURL(`http://localhost:5173?noteId=${note.id}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { noteId: note.id } })
  }

  // Send note data once renderer is ready
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('note-data', note)
  })

  noteWindows.set(note.id, win)
}

// ── Sync pinned notes: create/remove windows as needed ───────
async function syncPinnedNotes() {
  const pinned = await fetchPinned()
  const pinnedIds = new Set(pinned.map(n => n.id))

  // Remove windows for unpinned notes
  for (const [id, win] of noteWindows) {
    if (!pinnedIds.has(id)) {
      win.destroy()
      noteWindows.delete(id)
    }
  }

  // Create or update windows for pinned notes
  for (const note of pinned) {
    if (noteWindows.has(note.id)) {
      // Update content in existing window
      noteWindows.get(note.id)!.webContents.send('note-data', note)
    } else {
      createNoteWindow(note)
    }
  }
}

// ── Tray ──────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('OpenMemory — pinned notes')

  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      { label: `${noteWindows.size} note${noteWindows.size !== 1 ? 's' : ''} pinned`, enabled: false },
      { type: 'separator' },
      { label: 'Open OpenMemory', click: () => shell.openExternal('https://open-memory-nine.vercel.app') },
      { label: 'Refresh notes', click: () => syncPinnedNotes() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
    ])
    tray?.setContextMenu(menu)
  }

  rebuild()
  // Rebuild menu periodically to keep note count fresh
  setInterval(rebuild, POLL_INTERVAL)
  tray.on('click', () => shell.openExternal('https://open-memory-nine.vercel.app'))
}

// ── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  createTray()
  await syncPinnedNotes()
  setInterval(syncPinnedNotes, POLL_INTERVAL)
})

app.on('before-quit', () => { isQuitting = true })
app.on('window-all-closed', () => { if (isQuitting) app.quit() })

// ── IPC ───────────────────────────────────────────────────────
ipcMain.handle('set-ignore-mouse', (_e, ignore: boolean) => {
  const win = BrowserWindow.fromWebContents(_e.sender)
  win?.setIgnoreMouseEvents(ignore, { forward: true })
})

ipcMain.handle('close-note', (_e, noteId: string) => {
  // Unpin via backend then close
  fetch(`${BACKEND_URL}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: noteId, pinned: false, color: { bg: '#fde68a', text: '#78350f' } }),
  }).catch(() => {})
  const win = noteWindows.get(noteId)
  if (win) { win.destroy(); noteWindows.delete(noteId) }
})

ipcMain.handle('open-webapp', () => shell.openExternal('https://open-memory-nine.vercel.app'))

ipcMain.handle('save-todos', async (_e, noteId: string, todos: unknown[], color: { bg: string; text: string }) => {
  try {
    await fetch(`${BACKEND_URL}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: noteId,
        todos: JSON.stringify(todos),
        color: { bg: color.bg, text: color.text },
      }),
    })
  } catch {}
})
