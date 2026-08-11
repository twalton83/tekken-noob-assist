// XInput controller polling via koffi FFI. Reads the OS gamepad API only —
// never touches the game process.

import * as koffi from 'koffi';
import { EventEmitter } from 'node:events';
import type { Dir, Limb } from '../shared/types';

const XINPUT_GAMEPAD = koffi.struct('XINPUT_GAMEPAD', {
  wButtons: 'uint16',
  bLeftTrigger: 'uint8',
  bRightTrigger: 'uint8',
  sThumbLX: 'int16',
  sThumbLY: 'int16',
  sThumbRX: 'int16',
  sThumbRY: 'int16',
});
const XINPUT_STATE = koffi.struct('XINPUT_STATE', {
  dwPacketNumber: 'uint32',
  Gamepad: XINPUT_GAMEPAD,
});

const BTN = {
  DPAD_UP: 0x0001, DPAD_DOWN: 0x0002, DPAD_LEFT: 0x0004, DPAD_RIGHT: 0x0008,
  START: 0x0010, BACK: 0x0020,
  LB: 0x0100, RB: 0x0200,
  A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
} as const;

export type PadButton = 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT';

export interface Binds { [button: string]: Limb[] } // e.g. { X: [1], Y: [2], A: [3], B: [4], RB: [1,2] }

export interface PadSample {
  t: number;            // ms, performance.now()
  dir: Dir;             // relative to facing (side-corrected)
  limbs: Set<Limb>;     // limb buttons currently held
  connected: boolean;
}

export class XInputPoller extends EventEmitter {
  private getState: ((idx: number, out: object) => number) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastPacket = -1;
  private userIndex = -1;
  private lastConnectScan = 0;
  binds: Binds;
  side: 'p1' | 'p2' = 'p1';   // p1 = facing right (f = dpad right)

  constructor(binds: Binds) {
    super();
    this.binds = binds;
    try {
      let lib;
      try { lib = koffi.load('xinput1_4.dll'); }
      catch { lib = koffi.load('xinput9_1_0.dll'); }
      this.getState = lib.func('uint32 XInputGetState(uint32 dwUserIndex, _Out_ XINPUT_STATE* pState)') as never;
    } catch (e) {
      this.emit('error', new Error(`XInput unavailable: ${e}`));
    }
  }

  start(intervalMs = 2) {
    if (!this.getState || this.timer) return;
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll() {
    if (!this.getState) return;
    const now = performance.now();

    if (this.userIndex < 0) {
      if (now - this.lastConnectScan < 1000) return;
      this.lastConnectScan = now;
      for (let i = 0; i < 4; i++) {
        const st: Record<string, unknown> = {};
        if (this.getState(i, st) === 0) { this.userIndex = i; this.lastPacket = -1; break; }
      }
      if (this.userIndex < 0) {
        this.emit('sample', { t: now, dir: 'n', limbs: new Set(), connected: false } as PadSample);
        return;
      }
    }

    const st: { dwPacketNumber?: number; Gamepad?: { wButtons: number; bLeftTrigger: number; bRightTrigger: number } } = {};
    const res = this.getState(this.userIndex, st);
    if (res !== 0) { // disconnected
      this.userIndex = -1;
      this.emit('sample', { t: now, dir: 'n', limbs: new Set(), connected: false } as PadSample);
      return;
    }
    if (st.dwPacketNumber === this.lastPacket) return; // no change
    this.lastPacket = st.dwPacketNumber!;

    const gp = st.Gamepad!;
    const b = gp.wButtons;

    // d-pad -> direction (side-corrected: p1 faces right)
    const up = !!(b & BTN.DPAD_UP);
    const down = !!(b & BTN.DPAD_DOWN);
    let fwd = !!(b & (this.side === 'p1' ? BTN.DPAD_RIGHT : BTN.DPAD_LEFT));
    let back = !!(b & (this.side === 'p1' ? BTN.DPAD_LEFT : BTN.DPAD_RIGHT));
    if (fwd && back) { fwd = back = false; }
    let dir: Dir = 'n';
    if (up && fwd) dir = 'uf'; else if (up && back) dir = 'ub';
    else if (down && fwd) dir = 'df'; else if (down && back) dir = 'db';
    else if (up) dir = 'u'; else if (down) dir = 'd';
    else if (fwd) dir = 'f'; else if (back) dir = 'b';

    const limbs = new Set<Limb>();
    const add = (name: PadButton, held: boolean) => {
      if (!held) return;
      for (const l of this.binds[name] ?? []) limbs.add(l);
    };
    add('A', !!(b & BTN.A)); add('B', !!(b & BTN.B));
    add('X', !!(b & BTN.X)); add('Y', !!(b & BTN.Y));
    add('LB', !!(b & BTN.LB)); add('RB', !!(b & BTN.RB));
    add('LT', gp.bLeftTrigger > 80); add('RT', gp.bRightTrigger > 80);

    this.emit('sample', { t: now, dir, limbs, connected: true } as PadSample);
  }
}
