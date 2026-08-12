// Settings window: edits the live config. Every change is sent to main, which
// applies it immediately (overlay visuals, binds, hotkeys) and persists it.

import type { AppConfig, Limb } from '../shared/types.js';

declare global {
  interface Window {
    trainerApi: {
      on(channel: string, cb: (payload: unknown) => void): void;
      send(channel: string, payload?: unknown): void;
      ready(): void;
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;

const HOTKEY_LABELS: Record<string, string> = {
  mode: 'Freeplay / trainer mode',
  prevCombo: 'Previous combo',
  nextCombo: 'Next combo',
  lock: 'Lock / unlock overlay',
  moves: 'Move browser',
  side: 'Flip facing side',
  metronome: 'Metronome',
  reset: 'Reset attempt',
  opacity: 'Cycle appearance',
  quit: 'Quit',
  help: 'Hotkey hint row',
  settings: 'This window',
};

let cfg: AppConfig | null = null;
let characters: string[] = []; // available data/*.json move lists, sent by main
let muted = false; // true while populating controls from a config broadcast

function push() {
  if (cfg && !muted) window.trainerApi.send('set-config', cfg);
}

let pushTimer: number | undefined;
function pushDebounced() {
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(push, 350);
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function populateCharacters() {
  const sel = $('character') as HTMLSelectElement;
  sel.textContent = '';
  // before the list arrives, show at least the configured character
  const names = characters.length ? characters : cfg ? [cfg.character] : [];
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  if (cfg) sel.value = cfg.character;
}

function populate() {
  if (!cfg) return;
  muted = true;

  populateCharacters();

  const appearance = $('appearance') as HTMLSelectElement;
  appearance.textContent = '';
  const current = cfg.overlay.appearancePresets.findIndex(
    p => Math.abs(p.opacity - cfg!.overlay.opacity) < 0.01 && Math.abs(p.panelAlpha - cfg!.overlay.panelAlpha) < 0.01,
  );
  for (const [i, p] of cfg.overlay.appearancePresets.entries()) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p.name;
    appearance.appendChild(opt);
  }
  if (current === -1) {
    const opt = document.createElement('option');
    opt.value = '-1';
    opt.textContent = 'custom';
    appearance.appendChild(opt);
  }
  appearance.value = String(current);

  ($('panelAlpha') as HTMLInputElement).value = String(cfg.overlay.panelAlpha);
  $('panelAlpha-out').textContent = fmtPct(cfg.overlay.panelAlpha);
  ($('scale') as HTMLInputElement).value = String(cfg.overlay.scale);
  $('scale-out').textContent = fmtPct(cfg.overlay.scale);
  ($('showKeys') as HTMLInputElement).checked = cfg.overlay.showKeys;
  ($('onlyOverGame') as HTMLInputElement).checked = cfg.overlay.onlyOverGame;
  ($('gameTitle') as HTMLInputElement).value = cfg.overlay.gameTitle;
  ($('side') as HTMLSelectElement).value = cfg.side;
  ($('notationDiff') as HTMLSelectElement).value = cfg.notation.difficulty;

  const binds = $('binds');
  binds.textContent = '';
  for (const [btn, limbs] of Object.entries(cfg.binds)) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const name = document.createElement('span');
    name.className = 'pad-btn';
    name.textContent = btn;
    row.appendChild(name);
    for (const limb of [1, 2, 3, 4] as Limb[]) {
      const label = document.createElement('label');
      label.className = 'bind-limb';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = limbs.includes(limb);
      box.addEventListener('change', () => {
        if (!cfg) return;
        const set = new Set(cfg.binds[btn]);
        if (box.checked) set.add(limb); else set.delete(limb);
        cfg.binds[btn] = [...set].sort() as Limb[];
        push();
      });
      const txt = document.createElement('span');
      txt.textContent = String(limb);
      label.append(box, txt);
      row.appendChild(label);
    }
    binds.appendChild(row);
  }

  const hotkeys = $('hotkeys');
  hotkeys.textContent = '';
  for (const [action, accel] of Object.entries(cfg.hotkeys)) {
    const row = document.createElement('div');
    row.className = 'hotkey-row';
    const label = document.createElement('span');
    label.textContent = HOTKEY_LABELS[action] ?? action;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = accel;
    input.addEventListener('input', () => {
      if (!cfg) return;
      cfg.hotkeys[action] = input.value.trim();
      pushDebounced();
    });
    row.append(label, input);
    hotkeys.appendChild(row);
  }

  muted = false;
}

// static control wiring
$('character').addEventListener('change', () => {
  if (!cfg) return;
  cfg.character = ($('character') as HTMLSelectElement).value;
  push();
});
$('appearance').addEventListener('change', () => {
  if (!cfg) return;
  const idx = Number(($('appearance') as HTMLSelectElement).value);
  const preset = cfg.overlay.appearancePresets[idx];
  if (!preset) return;
  cfg.overlay.opacity = preset.opacity;
  cfg.overlay.panelAlpha = preset.panelAlpha;
  push();
});
$('panelAlpha').addEventListener('input', () => {
  if (!cfg) return;
  cfg.overlay.panelAlpha = Number(($('panelAlpha') as HTMLInputElement).value);
  $('panelAlpha-out').textContent = fmtPct(cfg.overlay.panelAlpha);
  pushDebounced();
});
$('scale').addEventListener('input', () => {
  if (!cfg) return;
  cfg.overlay.scale = Number(($('scale') as HTMLInputElement).value);
  $('scale-out').textContent = fmtPct(cfg.overlay.scale);
  pushDebounced();
});
$('showKeys').addEventListener('change', () => {
  if (!cfg) return;
  cfg.overlay.showKeys = ($('showKeys') as HTMLInputElement).checked;
  push();
});
$('onlyOverGame').addEventListener('change', () => {
  if (!cfg) return;
  cfg.overlay.onlyOverGame = ($('onlyOverGame') as HTMLInputElement).checked;
  push();
});
$('gameTitle').addEventListener('input', () => {
  if (!cfg) return;
  cfg.overlay.gameTitle = ($('gameTitle') as HTMLInputElement).value;
  pushDebounced();
});
$('notationDiff').addEventListener('change', () => {
  if (!cfg) return;
  cfg.notation.difficulty = ($('notationDiff') as HTMLSelectElement).value as AppConfig['notation']['difficulty'];
  push();
});
$('side').addEventListener('change', () => {
  if (!cfg) return;
  cfg.side = ($('side') as HTMLSelectElement).value as AppConfig['side'];
  push();
});
$('close-btn').addEventListener('click', () => window.trainerApi.send('settings-hide'));

window.trainerApi.on('characters', p => {
  characters = p as string[];
  populateCharacters();
});
window.trainerApi.on('config', p => {
  // ignore echoes while the user is mid-edit in a text field
  if (document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text') {
    cfg = p as AppConfig;
    return;
  }
  cfg = p as AppConfig;
  populate();
});
window.trainerApi.send('settings-ready');

export {};
