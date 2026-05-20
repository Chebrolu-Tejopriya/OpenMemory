import { useState, useEffect, useCallback } from 'react'

type TodoItem = { id: string; text: string; done: boolean }
type NoteData = {
  id: string
  title: string | null
  body: string | null
  color_bg: string
  color_text: string
  todos?: string | null
}

declare global {
  interface Window {
    electronAPI: {
      setIgnoreMouse: (ignore: boolean) => Promise<void>
      closeNote: (noteId: string) => Promise<void>
      openWebapp: () => Promise<void>
      onNoteData: (cb: (note: NoteData) => void) => void
      saveTodos: (noteId: string, todos: TodoItem[], color: { bg: string; text: string }) => Promise<void>
      startDrag: () => Promise<void>
      stopDrag: () => Promise<void>
    }
  }
}

function parseTodos(raw: string | null | undefined): TodoItem[] {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

function darken(hex: string, amount = 18): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = Math.max(0, (n >> 16) - amount)
  const g = Math.max(0, ((n >> 8) & 0xff) - amount)
  const b = Math.max(0, (n & 0xff) - amount)
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`
}

export default function App() {
  const [note, setNote] = useState<NoteData | null>(null)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [hovering, setHovering] = useState(false)

  useEffect(() => {
    window.electronAPI?.onNoteData((data) => {
      setNote(data)
      setTodos(parseTodos(data.todos))
    })
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const over = !!el && el !== document.documentElement && el !== document.body
      setHovering(over)
      window.electronAPI?.setIgnoreMouse(!over)
    }
    const onLeave = () => {
      setHovering(false)
      window.electronAPI?.setIgnoreMouse(true)
    }
    document.addEventListener('mousemove', onMove)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  const toggleTodo = useCallback((id: string) => {
    if (!note) return
    const updated = todos.map(t => t.id === id ? { ...t, done: !t.done } : t)
    setTodos(updated)
    window.electronAPI?.saveTodos(note.id, updated, { bg: note.color_bg, text: note.color_text })
  }, [note, todos])

  if (!note) return null

  const hasTodos = todos.length > 0
  const done = todos.filter(t => t.done).length
  const bg = note.color_bg || '#fde68a'
  const fg = note.color_text || '#78350f'
  const stripe = darken(bg, 18)

  return (
    <div className="card" style={{ '--bg': bg, '--fg': fg, '--stripe': stripe } as React.CSSProperties}>
      {/* Top bar — manual drag */}
      <div
        className="topbar"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          e.preventDefault()
          // Pass where in the window the user clicked so it doesn't jump
          window.electronAPI?.startDrag(0, 0)
          const onUp = () => {
            window.electronAPI?.stopDrag()
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mouseup', onUp)
        }}
        style={{ cursor: 'grab' }}
      >
        <div className="handle-dots">
          <span /><span /><span />
          <span /><span /><span />
        </div>
        {note.title && <div className="topbar-title">{note.title}</div>}
        <button
          className={`close-btn ${hovering ? 'visible' : ''}`}
          onClick={() => window.electronAPI?.closeNote(note.id)}
          title="Unpin from desktop"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="body">
        {note.body && !hasTodos && (
          <div className="text">{note.body}</div>
        )}

        {hasTodos && (
          <>
            <ul className="todos">
              {todos.map(t => (
                <li key={t.id} className={t.done ? 'done' : ''} onClick={() => toggleTodo(t.id)}>
                  <span className="checkbox">{t.done ? '☑' : '☐'}</span>
                  <span className="label">{t.text}</span>
                </li>
              ))}
            </ul>

            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.round(done / todos.length * 100)}%` }}
              />
            </div>
            <div className="progress-label">{done}/{todos.length} done</div>
          </>
        )}

        {!note.title && !note.body && !hasTodos && (
          <div className="empty">Empty note</div>
        )}
      </div>
    </div>
  )
}
