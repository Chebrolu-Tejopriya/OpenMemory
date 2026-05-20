import { useState, useEffect, useRef, useCallback } from 'react'

const BACKEND_URL = 'http://localhost:3000'

const NOTE_COLORS: NoteColor[] = [
  { bg: '#fffbe6', text: '#92400e' },
  { bg: '#fce7f3', text: '#9d174d' },
  { bg: '#e0f2fe', text: '#075985' },
  { bg: '#dcfce7', text: '#166534' },
  { bg: '#ede9fe', text: '#5b21b6' },
  { bg: '#fff7ed', text: '#9a3412' },
]

type NoteColor = { bg: string; text: string }

type Note = {
  id: string
  title: string
  body: string
  color_bg: string
  color_text: string
  created_at: string
  todos?: string | null
}

declare global {
  interface Window {
    electronAPI: {
      storeGet: (key: string) => Promise<unknown>
      storeSet: (key: string, value: unknown) => Promise<void>
      setIgnoreMouse: (ignore: boolean) => Promise<void>
      closeWindow: () => Promise<void>
      openWebapp: () => Promise<void>
    }
  }
}

// ── click-through: pass mouse events through transparent areas ──
function useClickThrough() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isOver = el && el !== document.documentElement && el !== document.body
      window.electronAPI?.setIgnoreMouse(!isOver)
    }
    document.addEventListener('mousemove', handler)
    // On mouse leave, ignore mouse events again
    document.documentElement.addEventListener('mouseleave', () => {
      window.electronAPI?.setIgnoreMouse(true)
    })
    return () => document.removeEventListener('mousemove', handler)
  }, [])
}

// ── API helpers ──
async function fetchNotes(): Promise<Note[]> {
  const res = await fetch(`${BACKEND_URL}/notes`)
  if (!res.ok) return []
  const data = await res.json()
  return data.notes || []
}

async function createNote(note: Partial<Note>): Promise<Note | null> {
  const id = crypto.randomUUID()
  const res = await fetch(`${BACKEND_URL}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      title: note.title || '',
      body: note.body || '',
      color: { bg: note.color_bg || NOTE_COLORS[0].bg, text: note.color_text || NOTE_COLORS[0].text },
      createdAt: new Date().toISOString(),
    }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.note || null
}

async function updateNote(id: string, patch: Partial<Note>): Promise<void> {
  await fetch(`${BACKEND_URL}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      title: patch.title ?? '',
      body: patch.body ?? '',
      color: { bg: patch.color_bg, text: patch.color_text },
    }),
  })
}

async function deleteNote(id: string): Promise<void> {
  await fetch(`${BACKEND_URL}/notes/${id}`, { method: 'DELETE' })
}

// ── NoteCard ──────────────────────────────────────────────────
function NoteCard({
  note,
  onDelete,
  onUpdate,
}: {
  note: Note
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: Partial<Note>) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const save = useCallback(() => {
    setEditing(false)
    if (title !== note.title || body !== note.body) {
      onUpdate(note.id, { ...note, title, body })
    }
  }, [title, body, note, onUpdate])

  useEffect(() => {
    if (editing) bodyRef.current?.focus()
  }, [editing])

  const hasTodos = (() => {
    if (!note.todos) return false
    try { return JSON.parse(note.todos).length > 0 } catch { return false }
  })()

  const todoStats = (() => {
    if (!note.todos) return null
    try {
      const todos = JSON.parse(note.todos) as { done: boolean; text: string }[]
      return { total: todos.length, done: todos.filter(t => t.done).length }
    } catch { return null }
  })()

  return (
    <div
      style={{ background: note.color_bg, borderColor: note.color_text + '30' }}
      className="note-card"
    >
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Title"
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontWeight: 600,
              fontSize: 13,
              color: note.color_text,
              width: '100%',
              userSelect: 'text',
            }}
            onKeyDown={e => e.key === 'Escape' && save()}
          />
          <textarea
            ref={bodyRef}
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Note..."
            rows={4}
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              fontSize: 12,
              color: note.color_text + 'cc',
              width: '100%',
              lineHeight: 1.5,
              userSelect: 'text',
            }}
            onKeyDown={e => e.key === 'Escape' && save()}
          />
          <button
            onClick={save}
            style={{
              alignSelf: 'flex-end',
              padding: '3px 10px',
              borderRadius: 6,
              border: 'none',
              background: note.color_text + '22',
              color: note.color_text,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Save
          </button>
        </div>
      ) : (
        <div onClick={() => setEditing(true)} style={{ cursor: 'text' }}>
          {title && (
            <div style={{ fontWeight: 600, fontSize: 13, color: note.color_text, marginBottom: 3 }}>
              {title}
            </div>
          )}
          {body && (
            <div style={{
              fontSize: 12,
              color: note.color_text + 'aa',
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {body}
            </div>
          )}
          {!title && !body && (
            <div style={{ fontSize: 12, color: note.color_text + '55', fontStyle: 'italic' }}>
              Empty note — click to edit
            </div>
          )}
          {hasTodos && todoStats && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                flex: 1,
                height: 3,
                background: note.color_text + '20',
                borderRadius: 2,
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${todoStats.total > 0 ? Math.round(todoStats.done / todoStats.total * 100) : 0}%`,
                  height: '100%',
                  background: note.color_text + '60',
                  borderRadius: 2,
                }} />
              </div>
              <span style={{ fontSize: 10, color: note.color_text + '70' }}>
                {todoStats.done}/{todoStats.total}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Delete button — top right */}
      {!editing && (
        <button
          onClick={e => { e.stopPropagation(); onDelete(note.id) }}
          className="delete-btn"
          style={{ color: note.color_text + '60' }}
          title="Delete"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────
export default function App() {
  useClickThrough()

  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const load = useCallback(async () => {
    try {
      const fetched = await fetchNotes()
      setNotes(fetched)
    } catch { /* backend not running */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [load])

  const handleCreate = async () => {
    const color = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)]
    const created = await createNote({ color_bg: color.bg, color_text: color.text })
    if (created) setNotes(prev => [created, ...prev])
  }

  const handleDelete = async (id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id))
    await deleteNote(id)
  }

  const handleUpdate = async (id: string, patch: Partial<Note>) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...patch } : n))
    await updateNote(id, patch)
  }

  return (
    <div id="widget">
      {/* ── Drag handle / header ── */}
      <div id="header" className="drag-region">
        <span id="header-title">📝 Notes</span>
        <div id="header-actions">
          <button
            className="header-btn"
            onClick={handleCreate}
            title="New note"
          >
            +
          </button>
          <button
            className="header-btn"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▲' : '▼'}
          </button>
          <button
            className="header-btn"
            onClick={() => window.electronAPI?.closeWindow()}
            title="Hide"
          >
            ×
          </button>
        </div>
      </div>

      {/* ── Notes list ── */}
      {!collapsed && (
        <div id="notes-list">
          {loading && (
            <div className="empty-state">Loading...</div>
          )}
          {!loading && notes.length === 0 && (
            <div className="empty-state">
              No notes yet.
              <button className="add-first-btn" onClick={handleCreate}>
                + Add your first note
              </button>
            </div>
          )}
          {notes.map(note => (
            <NoteCard
              key={note.id}
              note={note}
              onDelete={handleDelete}
              onUpdate={handleUpdate}
            />
          ))}
        </div>
      )}

      {/* ── Footer ── */}
      {!collapsed && (
        <div id="footer" className="drag-region">
          <button
            id="open-webapp-btn"
            onClick={() => window.electronAPI?.openWebapp()}
          >
            Open OpenMemory ↗
          </button>
        </div>
      )}
    </div>
  )
}
