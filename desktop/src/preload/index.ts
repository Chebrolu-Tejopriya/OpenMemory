import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  closeNote: (noteId: string) => ipcRenderer.invoke('close-note', noteId),
  openWebapp: () => ipcRenderer.invoke('open-webapp'),
  onNoteData: (cb: (note: unknown) => void) => {
    ipcRenderer.on('note-data', (_event, note) => cb(note))
  },
  saveTodos: (noteId: string, todos: unknown[], color: { bg: string; text: string }) =>
    ipcRenderer.invoke('save-todos', noteId, todos, color),
  startDrag: () => ipcRenderer.invoke('start-drag'),
  stopDrag: (x: number, y: number) => ipcRenderer.invoke('stop-drag', x, y),
})
