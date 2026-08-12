import { contextBridge, ipcRenderer } from 'electron';

const listenChannels = ['init', 'move', 'trainer', 'pad', 'lock', 'metronome', 'input', 'moves', 'selected', 'config', 'characters', 'notation'] as const;
const sendChannels = ['renderer-ready', 'moves-ready', 'select-move', 'moves-hide', 'open-settings', 'settings-ready', 'settings-hide', 'set-config', 'set-mode', 'notation-skip', 'notation-difficulty'] as const;

contextBridge.exposeInMainWorld('trainerApi', {
  on(channel: string, cb: (payload: unknown) => void) {
    if (!(listenChannels as readonly string[]).includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
  send(channel: string, payload?: unknown) {
    if (!(sendChannels as readonly string[]).includes(channel)) return;
    ipcRenderer.send(channel, payload);
  },
  ready() { ipcRenderer.send('renderer-ready'); },
});
