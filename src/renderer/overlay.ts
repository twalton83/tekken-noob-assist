// Overlay renderer: freeplay move ticker, trainer combo strip, live pad view,
// and the WebAudio metronome. Receives everything over IPC from main.

import { DIR_GLYPH, LIMB_BTN, renderTokens } from './icons.js';
import type {
  InputEventMsg, MetronomeMsg, NotationStateMsg, OverlayInit, PadStateMsg,
  RecognizedMoveMsg, TrainerStateMsg,
} from '../shared/types.js';

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

// ---- freeplay ticker ----
const MAX_TICKER = 4;
function onMove(msg: RecognizedMoveMsg) {
  const ticker = $('ticker');
  const entry = document.createElement('div');
  entry.className = 'ticker-entry';

  const name = document.createElement('span');
  name.className = 'move-name';
  name.textContent = msg.name ?? msg.command;
  entry.appendChild(name);

  const cmd = document.createElement('span');
  cmd.className = 'move-cmd';
  cmd.textContent = msg.command;
  entry.appendChild(cmd);

  entry.appendChild(renderTokens(msg.tokens));

  if (msg.electric === true) {
    const el = document.createElement('span');
    el.className = 'electric';
    el.textContent = '⚡ ELECTRIC';
    entry.appendChild(el);
  } else if (msg.electric === false && msg.jfGapMs !== null) {
    const el = document.createElement('span');
    el.className = 'not-electric';
    el.textContent = `gap ${msg.jfGapMs.toFixed(0)}ms`;
    entry.appendChild(el);
  }
  if (msg.approximate) {
    const el = document.createElement('span');
    el.className = 'approx';
    el.textContent = '≈';
    el.title = 'state-dependent — matched by input only';
    entry.appendChild(el);
  }
  if (msg.alternates.length) {
    const el = document.createElement('span');
    el.className = 'move-alt';
    el.textContent = `(or ${msg.alternates.join(' / ')})`;
    entry.appendChild(el);
  }

  ticker.appendChild(entry);
  while (ticker.children.length > MAX_TICKER) ticker.removeChild(ticker.firstChild!);
  setTimeout(() => entry.classList.add('fading'), 2600);
  setTimeout(() => { if (entry.parentElement) entry.remove(); }, 3900);
}

// ---- trainer ----
function onTrainer(msg: TrainerStateMsg) {
  $('combo-name').textContent = msg.comboName;
  $('combo-idx').textContent = `${msg.comboIndex + 1}/${msg.comboCount}`;
  $('combo-note').textContent = msg.note ?? '';

  const strip = $('combo-strip');
  strip.textContent = '';
  for (const [i, step] of msg.steps.entries()) {
    const el = document.createElement('div');
    el.className = `step ${step.verdict}`;
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    el.appendChild(idx);
    el.appendChild(renderTokens(step.tokens));
    const label = document.createElement('span');
    label.className = 'delta';
    if (step.verdict === 'good') {
      label.textContent = '✓';
    } else if (step.deltaFrames !== null && (step.verdict === 'early' || step.verdict === 'late')) {
      label.textContent = `${step.deltaFrames > 0 ? '+' : ''}${step.deltaFrames.toFixed(1)}f`;
    } else if (step.verdict === 'wrong') {
      label.textContent = 'wrong';
    } else if (step.verdict === 'missed') {
      label.textContent = 'miss';
    } else {
      label.textContent = msg.kind === 'move-drill' ? '·' : `${step.idealFrame}f`;
    }
    el.appendChild(label);
    strip.appendChild(el);
  }

  const summary = $('summary');
  summary.textContent = msg.lastSummary ?? '';
  const s = msg.lastSummary ?? '';
  summary.className = s.startsWith('Clean') || s.startsWith('⚡') || s.startsWith('Hit!') ? 'clean' : '';
}

// ---- Tekken-style input history (trainer mode) ----
const MAX_HISTORY = 16;
function onInputEvent(msg: InputEventMsg) {
  if (msg.kind === 'dir' && msg.dir === 'n') return; // returns-to-neutral clutter
  const hist = $('input-history');
  const entry = document.createElement('span');
  entry.className = 'hist-entry';

  if (msg.dir !== 'n' || msg.buttons.length === 0) {
    const d = document.createElement('span');
    d.className = 'tok-dir';
    d.textContent = DIR_GLYPH[msg.dir];
    entry.appendChild(d);
  }
  if (msg.buttons.length) {
    const btns = document.createElement('span');
    btns.className = 'tok-btns';
    for (const limb of msg.buttons) {
      const b = LIMB_BTN[limb];
      const ic = document.createElement('span');
      ic.className = `btn-ic ${b.cls}`;
      ic.textContent = b.label;
      btns.appendChild(ic);
    }
    entry.appendChild(btns);
  }

  hist.appendChild(entry);
  while (hist.children.length > MAX_HISTORY) hist.removeChild(hist.firstChild!);
  // age out: everything but the last 8 dims
  const kids = [...hist.children];
  kids.forEach((k, i) => k.classList.toggle('old', i < kids.length - 8));
}

// ---- notation drill ----
function onNotation(msg: NotationStateMsg) {
  document.querySelectorAll<HTMLButtonElement>('.nota-diff-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.diff === msg.difficulty));
  $('nota-score').textContent = `streak ${msg.streak} · ${msg.hits}/${msg.total}`;
  $('nota-prompt').textContent = msg.command;
  $('nota-progress').textContent = msg.stepCount > 1
    ? Array.from({ length: msg.stepCount }, (_, i) => (i < msg.stepIndex ? '●' : '○')).join(' ')
    : '';

  const fb = $('nota-feedback');
  fb.textContent = '';
  fb.className = '';
  if (!msg.feedback) return;
  fb.className = msg.feedback.kind === 'correct' ? 'ok' : 'bad';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = msg.feedback.kind === 'correct' ? '✓' : '✗';
  fb.appendChild(mark);
  fb.appendChild(renderTokens(msg.feedback.expectedTokens));
  if (msg.feedback.kind === 'wrong' && msg.feedback.gotTokens) {
    const sep = document.createElement('span');
    sep.className = 'nota-got';
    sep.textContent = 'you pressed';
    fb.appendChild(sep);
    fb.appendChild(renderTokens(msg.feedback.gotTokens));
  }
}

// ---- pad view ----
function onPad(msg: PadStateMsg) {
  $('pad-dir').textContent = DIR_GLYPH[msg.dir];
  const btns = $('pad-btns');
  btns.textContent = '';
  for (const limb of msg.buttons) {
    const b = LIMB_BTN[limb];
    const ic = document.createElement('span');
    ic.className = `btn-ic ${b.cls}`;
    ic.textContent = b.label;
    btns.appendChild(ic);
  }
  const conn = $('conn');
  conn.classList.toggle('ok', msg.connected);
  conn.classList.toggle('off', !msg.connected);
  conn.setAttribute('title', msg.connected ? 'controller connected' : 'controller DISCONNECTED');
}

// ---- metronome (WebAudio) ----
let audioCtx: AudioContext | null = null;
let metroTimer: number | null = null;

function tick(accent: boolean) {
  if (!audioCtx) audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = accent ? 1200 : 800;
  gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.07);
}

function onMetronome(msg: MetronomeMsg) {
  if (metroTimer !== null) { clearTimeout(metroTimer); metroTimer = null; }
  const pill = $('metro-pill');
  pill.className = msg.on ? '' : 'off';
  if (!msg.on || msg.beatsMs.length === 0) return;

  const loopLen = msg.beatsMs[msg.beatsMs.length - 1] + msg.loopGapMs;
  const loop = () => {
    for (const [i, at] of msg.beatsMs.entries()) {
      window.setTimeout(() => tick(i === 0), at);
    }
    metroTimer = window.setTimeout(loop, loopLen);
  };
  loop();
}

// ---- init / wiring ----
function onInit(msg: OverlayInit) {
  if (typeof msg.panelAlpha === 'number') {
    document.documentElement.style.setProperty('--panel-alpha', String(msg.panelAlpha));
  }
  $('mode-pill').textContent = msg.mode.toUpperCase();
  $('side-pill').textContent = msg.side.toUpperCase();
  $('opacity-pill').textContent =
    msg.appearanceName?.toUpperCase() ?? `${Math.round(msg.opacity * 100)}%`;

  const hk = msg.hotkeys;
  const bindings: [string[], string][] = [
    [[hk.mode], 'mode'],
    [[hk.prevCombo, hk.nextCombo], 'combo'],
    [[hk.moves], 'moves'],
    [[hk.lock], 'lock'],
    [[hk.side], 'side'],
    [[hk.metronome], 'metro'],
    [[hk.reset], 'reset'],
    [[hk.opacity], 'opacity'],
    [[hk.help], 'hide this'],
    [[hk.quit], 'quit'],
  ];
  const keys = $('keys');
  keys.textContent = '';
  bindings.forEach(([caps, label], i) => {
    if (i) keys.appendChild(document.createTextNode('  '));
    caps.forEach((cap, j) => {
      if (j) keys.appendChild(document.createTextNode('/'));
      const kb = document.createElement('kbd');
      kb.textContent = cap;
      keys.appendChild(kb);
    });
    keys.appendChild(document.createTextNode(` ${label}`));
  });
  $('keys').classList.toggle('hidden', !msg.showKeys);
  $('freeplay').classList.toggle('hidden', msg.mode !== 'freeplay');
  $('trainer').classList.toggle('hidden', msg.mode !== 'trainer');
  $('notation').classList.toggle('hidden', msg.mode !== 'notation');
}

function onLock(msg: { locked: boolean }) {
  $('root').classList.toggle('locked', msg.locked);
}

// clickable controls (usable while the overlay is unlocked; hotkeys mirror them)
$('mode-pill').addEventListener('click', () => window.trainerApi.send('set-mode'));
$('nota-skip').addEventListener('click', () => window.trainerApi.send('notation-skip'));
document.querySelectorAll<HTMLButtonElement>('.nota-diff-btn').forEach(b =>
  b.addEventListener('click', () => window.trainerApi.send('notation-difficulty', b.dataset.diff)));

window.trainerApi.on('init', p => { onInit(p as OverlayInit); });
window.trainerApi.on('lock', p => onLock(p as { locked: boolean }));
window.trainerApi.on('move', p => onMove(p as RecognizedMoveMsg));
window.trainerApi.on('trainer', p => onTrainer(p as TrainerStateMsg));
window.trainerApi.on('pad', p => onPad(p as PadStateMsg));
window.trainerApi.on('input', p => onInputEvent(p as InputEventMsg));
window.trainerApi.on('metronome', p => onMetronome(p as MetronomeMsg));
window.trainerApi.on('notation', p => onNotation(p as NotationStateMsg));
window.trainerApi.ready();

export {};
