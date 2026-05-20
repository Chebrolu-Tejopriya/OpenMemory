import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  storeGet: (key: string) => ipcRenderer.invoke('store-get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store-set', key, value),
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  openWebapp: () => ipcRenderer.invoke('open-webapp'),
})
