import { useState, useEffect } from 'react'

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
    }
  }
}

function parseTodos(raw: string | null | undefined): TodoItem[] {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

export default function App() {
  const [note, setNote] = useState<NoteData | null>(null)

  useEffect(() => {
    window.electronAPI?.onNoteData((data) => setNote(data))
  }, [])

  // Click-through transparent areas
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isOver = el && el !== document.documentElement && el !== document.body
      window.electronAPI?.setIgnoreMouse(!isOver)
    }
    document.addEventListener('mousemove', handler)
    document.documentElement.addEventListener('mouseleave', () => {
      window.electronAPI?.setIgnoreMouse(true)
    })
    return () => document.removeEventListener('mousemove', handler)
  }, [])

  if (!note) return null

  const todos = parseTodos(note.todos)
  const doneTodos = todos.filter(t => t.done).length
  const bg = note.color_bg || '#fde68a'
  const fg = note.color_text || '#78350f'

  return (
    <div
      id="card"
      style={{ background: bg, '--fg': fg } as React.CSSProperties}
    >
      {/* Drag handle bar */}
      <div id="drag-bar" className="drag-region">
        <div id="drag-dots" />
        <button
          id="close-btn"
          onClick={() => window.electronAPI?.closeNote(note.id)}
          title="Remove from desktop"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div id="content">
        {note.title && (
          <p id="title" style={{ color: fg }}>{note.title}</p>
        )}
        {note.body && (
          <p id="body" style={{ color: fg }}>{note.body}</p>
        )}
        {todos.length > 0 && (
          <div id="todos">
            {todos.map(t => (
              <div key={t.id} className="todo-item">
                <span className="todo-check" style={{ color: fg, opacity: t.done ? 0.4 : 0.7 }}>
                  {t.done ? '✓' : '○'}
                </span>
                <span style={{ color: fg, opacity: t.done ? 0.4 : 0.85, textDecoration: t.done ? 'line-through' : 'none' }}>
                  {t.text}
                </span>
              </div>
            ))}
            {todos.length > 0 && (
              <div id="todo-bar">
                <div id="todo-fill" style={{ width: `${Math.round(doneTodos / todos.length * 100)}%`, background: fg + '50' }} />
              </div>
            )}
          </div>
        )}
        {!note.title && !note.body && todos.length === 0 && (
          <p id="empty" style={{ color: fg }}>Empty note</p>
        )}
      </div>
    </div>
  )
}
