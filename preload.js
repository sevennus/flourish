/*
 * preload.js — the only bridge between the sandboxed renderer and main.
 * Exposes a narrow window.flourishAPI; the renderer gets no Node and no raw
 * ipcRenderer.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld('flourishAPI', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  sshTest: (cfg) => ipcRenderer.invoke('ssh:test', cfg),
  resetSession: () => ipcRenderer.invoke('session:reset'),

  // Which app shell is running. The renderer knows its OWN build from
  // build-info.js, but when the UI is served live off the VM those are two
  // different commits — and the gap between them is the whole reason this exists.
  getBuild: () => ipcRenderer.invoke('build:get'),

  // chat
  send: (payload) => ipcRenderer.send('chat:send', payload),
  abort: (requestId) => ipcRenderer.send('chat:abort', { requestId }),

  // streaming + status events (each returns an unsubscribe fn)
  onDelta: (cb) => on('chat:delta', cb),
  onTool: (cb) => on('chat:tool', cb),
  onDone: (cb) => on('chat:done', cb),
  onError: (cb) => on('chat:error', cb),
  onStatus: (cb) => on('ssh:status', cb),
  onAuto: (cb) => on('session:auto', cb),
});
