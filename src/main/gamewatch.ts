// Foreground-window watcher: lets the overlay show only while the game is
// focused. Reads window titles via user32 (the same thing a taskbar does) —
// never touches the game process itself.

import * as koffi from 'koffi';
import { EventEmitter } from 'node:events';

export class GameWatch extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private gameForeground: boolean | null = null;
  private fns: {
    GetForegroundWindow: () => unknown;
    GetWindowTextW: (hwnd: unknown, buf: Buffer, max: number) => number;
    GetWindowThreadProcessId: (hwnd: unknown, pid: Buffer) => number;
  } | null = null;

  constructor(private titleMatch: string) {
    super();
    try {
      const user32 = koffi.load('user32.dll');
      this.fns = {
        GetForegroundWindow: user32.func('void* GetForegroundWindow()') as never,
        GetWindowTextW: user32.func('int GetWindowTextW(void* hWnd, _Out_ uint8_t* lpString, int nMaxCount)') as never,
        GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void* hWnd, _Out_ uint8_t* lpdwProcessId)') as never,
      };
    } catch {
      this.fns = null; // user32 unavailable — watcher stays inert, overlay stays visible
    }
  }

  start(intervalMs = 500) {
    if (!this.fns || this.timer) return;
    this.timer = setInterval(() => this.check(), intervalMs);
    this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private check() {
    if (!this.fns) return;
    const hwnd = this.fns.GetForegroundWindow();
    let show = false;
    if (hwnd) {
      const pid = Buffer.alloc(4);
      this.fns.GetWindowThreadProcessId(hwnd, pid);
      // one of our own windows (move browser) — keep the current state
      if (pid.readUInt32LE(0) === process.pid) return;
      const buf = Buffer.alloc(512);
      const len = this.fns.GetWindowTextW(hwnd, buf, 255);
      const title = buf.toString('utf16le', 0, Math.max(0, len) * 2);
      show = title.toLowerCase().includes(this.titleMatch.toLowerCase());
    }
    if (show !== this.gameForeground) {
      this.gameForeground = show;
      this.emit('game', show);
    }
  }
}
