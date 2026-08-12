// User config: button binds, overlay position, facing side. Stored in
// config/config.json (created on first run, safe to hand-edit).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../shared/types';

export type { AppConfig };

const DEFAULTS: AppConfig = {
  _doc: 'binds map Xbox buttons to Tekken limbs (1=LP 2=RP 3=LK 4=RK). Match these to your in-game controller settings. side p1 = you face right. hotkeys use Electron accelerator names (F1, Ctrl+Shift+M, ...). overlay: width/height size the window, scale zooms everything in it, panelAlpha (0..1) sets how dark the glass panel is, appearancePresets is the cycle the opacity hotkey walks through (each preset = window opacity + glass darkness).',
  character: 'Jin',
  binds: { X: [1], Y: [2], A: [3], B: [4], LB: [], RB: [], LT: [], RT: [] },
  side: 'p1',
  overlay: {
    x: null, y: null,
    width: 820, height: 310,
    locked: false, opacity: 1, showKeys: true,
    onlyOverGame: false,
    gameTitle: 'tekken',
    scale: 1,
    panelAlpha: 0.85,
    appearancePresets: [
      { name: 'solid', opacity: 1, panelAlpha: 1 },
      { name: 'dark', opacity: 1, panelAlpha: 0.85 },
      { name: 'glass', opacity: 1, panelAlpha: 0.65 },
      { name: 'faint', opacity: 0.8, panelAlpha: 0.55 },
      { name: 'ghost', opacity: 0.55, panelAlpha: 0.45 },
    ],
  },
  hotkeys: {
    mode: 'F1',
    prevCombo: 'F2',
    nextCombo: 'F3',
    lock: 'F4',
    moves: 'F5',
    side: 'F6',
    metronome: 'F7',
    reset: 'F8',
    opacity: 'F9',
    quit: 'F10',
    help: 'F11',
    settings: 'F12',
  },
  notation: { difficulty: 'easy' },
};

function merge(base: AppConfig, over: Partial<AppConfig>): AppConfig {
  return {
    ...base, ...over,
    binds: { ...base.binds, ...over.binds },
    overlay: { ...base.overlay, ...over.overlay },
    hotkeys: { ...base.hotkeys, ...over.hotkeys },
    notation: { ...base.notation, ...over.notation },
  };
}

export class Config {
  path: string;
  data: AppConfig;

  constructor(rootDir: string) {
    const dir = join(rootDir, 'config');
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'config.json');
    if (existsSync(this.path)) {
      try {
        this.data = merge(DEFAULTS, JSON.parse(readFileSync(this.path, 'utf8')));
      } catch {
        this.data = { ...DEFAULTS };
      }
    } else {
      this.data = { ...DEFAULTS };
      this.save();
    }
  }

  /** Replace the config with values from the settings window (missing keys keep current values). */
  replace(next: Partial<AppConfig>) {
    this.data = merge(this.data, next);
    this.save();
  }

  save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}
