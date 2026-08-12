// Electron main: overlay window, global hotkeys, and the wiring between
// XInput poller -> recognizer/trainer -> overlay renderer.
//
// Safety: this app reads the OS gamepad API (XInput) and draws its own
// transparent window. It never reads game memory, injects, or hooks Tekken.

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { compileAll, friendlyText, stepsToTokens, type CompiledMove, type RawMove, type Step } from '../shared/notation';
import { Recognizer, annotateStanceHints, dirCovers } from './recognizer';
import { Trainer, type ComboDef, type DrillStep } from './trainer';
import { XInputPoller, type PadSample } from './xinput';
import { GameWatch } from './gamewatch';
import { NotationDrill } from './notation-drill';
import { Config } from './config';
import type { AppConfig, Dir, Limb, Mode, RecognizedMoveMsg, TrainerStateMsg } from '../shared/types';

const ROOT = join(__dirname, '..', '..');

let win: BrowserWindow | null = null;
let movesWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let quitting = false;
let mode: Mode = 'freeplay';
let metronomeOn = false;

// packaged: config lives in the user profile (the install dir is read-only)
const config = new Config(app.isPackaged ? app.getPath('userData') : ROOT);

// --- data & engine state (rebuilt when the character changes) ---
const stanceOverrides = JSON.parse(readFileSync(join(ROOT, 'data', 'stances.json'), 'utf8'));
const combosFile = JSON.parse(readFileSync(join(ROOT, 'data', 'combos.json'), 'utf8'));

// moves stay loosely typed — they're raw wavu JSON rows (see data/*.json)
let charData: { character: string; moves: any[] };
let compiled: Map<string, CompiledMove>;
let recognizer: Recognizer;
let trainer: Trainer;

const characterFile = (name: string) =>
  join(ROOT, 'data', `${name.toLowerCase().replace(/\s+/g, '-')}.json`);

// characters = every data/*.json that looks like a fetched move list
function listCharacters(): string[] {
  const names: string[] = [];
  for (const f of readdirSync(join(ROOT, 'data'))) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
      if (j.character && Array.isArray(j.moves)) names.push(j.character);
    } catch { /* not a character file */ }
  }
  return names.sort();
}

function onMove(msg: RecognizedMoveMsg) {
  if (mode === 'freeplay') win?.webContents.send('move', msg);
  trainer.onMove(msg);
}

function onTrainerState(msg: TrainerStateMsg) {
  if (mode === 'trainer') win?.webContents.send('trainer', msg);
}

function loadCharacter(name: string) {
  let file = characterFile(name);
  if (!existsSync(file)) {
    console.warn(`no move data for "${name}" — falling back to Jin (add characters with: npm run fetch-data <Name>)`);
    file = characterFile('Jin');
  }
  charData = JSON.parse(readFileSync(file, 'utf8'));
  if (config.data.character !== charData.character) {
    config.data.character = charData.character; // fallback happened — keep config truthful
    config.save();
  }

  const raws: RawMove[] = charData.moves.map(m => ({
    id: m.id, name: m.name, command: m.command, parent: m.parent, notes: m.notes,
  }));
  compiled = compileAll(raws);
  annotateStanceHints(compiled, charData.moves, stanceOverrides);

  const combos: ComboDef[] = [...(combosFile.characters?.[charData.character] ?? [])];
  // give curated move drills (EWGF) icon cards too
  for (const c of combos) {
    if (c.kind === 'move-drill' && c.moveId && !c.drillSteps) {
      const m = compiled.get(c.moveId);
      if (m && !m.unrecognizable) c.drillSteps = buildDrillSteps(m);
    }
  }
  // the trainer needs at least one combo — fall back to a jab drill
  if (!combos.length) {
    const jab = [...compiled.values()].find(m => m.command === '1' && !m.unrecognizable);
    if (jab) combos.push(buildDrillCombo(jab));
  }

  recognizer?.removeAllListeners();
  trainer?.removeAllListeners();
  recognizer = new Recognizer(compiled);
  recognizer.on('move', onMove);
  trainer = new Trainer(combos, id => compiled.get(id));
  trainer.on('state', onTrainerState);
  trainer.active = mode === 'trainer';
}

// Per-hit display cards for a move drill: cut the move's step chain after each
// press so every hit gets its own icon card.
function buildDrillSteps(m: CompiledMove): DrillStep[] {
  const out: DrillStep[] = [];
  let seg: Step[] = [];
  for (const s of m.steps) {
    seg.push(s);
    if (s.kind === 'press') {
      const tokens = stepsToTokens(seg);
      out.push({ label: friendlyText(tokens), tokens, buttons: s.buttons });
      seg = [];
    }
  }
  const stateToks = m.tokens.filter(t => t.kind === 'state');
  if (stateToks.length && out.length) out[0].tokens = [...stateToks, ...out[0].tokens];
  return out;
}

function siblingVariantId(m: CompiledMove): string | undefined {
  const alt = m.command.includes(':') ? m.command.replace(':', '+') : m.command.replace('+', ':');
  if (alt === m.command) return undefined;
  return [...compiled.values()].find(o => o.command === alt && !o.unrecognizable)?.id;
}

function buildDrillCombo(m: CompiledMove): ComboDef {
  const raw = charData.moves.find((r: { id: string }) => r.id === m.id);
  const facts = [
    raw?.startup ? `startup ${raw.startup}` : null,
    raw?.damage ? `dmg ${raw.damage}` : null,
    raw?.onBlock ? `${raw.onBlock} on block` : null,
    raw?.onHit ? `${raw.onHit} on hit` : null,
  ].filter(Boolean).join(' · ');
  return {
    id: `custom:${m.id}`,
    name: `${friendlyText(m.tokens)}  (${m.command})${m.name ? ` — ${m.name}` : ''}`,
    kind: 'move-drill',
    moveId: m.id,
    altMoveId: siblingVariantId(m),
    note: facts || undefined,
    drillSteps: buildDrillSteps(m),
  };
}

// --- engine ---
loadCharacter(config.data.character);
const notationDrill = new NotationDrill();
notationDrill.difficulty = config.data.notation.difficulty;
notationDrill.on('state', msg => {
  if (mode === 'notation') win?.webContents.send('notation', msg);
});
const poller = new XInputPoller(config.data.binds);
poller.side = config.data.side;

let lastHeld = new Set<Limb>();
let lastPadSend = 0;
let lastDir: string = 'n';

poller.on('sample', (s: PadSample) => {
  recognizer.feed(s);
  // rising-edge presses also feed the trainer and the input-history strip
  const newly: Limb[] = [];
  for (const l of s.limbs) if (!lastHeld.has(l)) newly.push(l);
  lastHeld = new Set(s.limbs);
  // a direction packet landing just after the button packet upgrades the
  // pending press's dir ("simultaneous" dir+button arrive in either order)
  if (pendingTrainer && s.t - pendingTrainer.t <= 18 && dirCovers(s.dir, pendingTrainer.edgeDir)) {
    pendingTrainer.dir = s.dir;
  }
  if (newly.length) trainerPress(s.t, newly, s.dir);

  if (s.dir !== lastDir) {
    lastDir = s.dir;
    win?.webContents.send('input', { kind: 'dir', dir: s.dir, buttons: [], t: s.t });
  }

  if (s.t - lastPadSend > 33) { // live pad view at ~30Hz
    lastPadSend = s.t;
    win?.webContents.send('pad', { dir: s.dir, buttons: [...s.limbs], connected: s.connected });
  }
});

// merge presses within one frame so chords (1+2) count as one input
let pendingTrainer: { t: number; buttons: Set<Limb>; dir: Dir; edgeDir: Dir; timer: NodeJS.Timeout } | null = null;
function trainerPress(t: number, limbs: Limb[], dir: Dir) {
  if (pendingTrainer && t - pendingTrainer.t <= 18) {
    limbs.forEach(l => pendingTrainer!.buttons.add(l));
    return;
  }
  flushTrainerPress();
  const entry = { t, buttons: new Set(limbs), dir, edgeDir: dir, timer: setTimeout(flushTrainerPress, 20) };
  pendingTrainer = entry;
}
function flushTrainerPress() {
  if (!pendingTrainer) return;
  clearTimeout(pendingTrainer.timer);
  const { t, buttons, dir } = pendingTrainer;
  pendingTrainer = null;
  const sorted = [...buttons].sort() as Limb[];
  trainer.onPress(t, sorted);
  notationDrill.onPress(sorted, dir, t);
  win?.webContents.send('input', { kind: 'press', dir, buttons: sorted, t });
}

// --- overlay window ---
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = config.data.overlay.width, h = config.data.overlay.height;
  const x = config.data.overlay.x ?? Math.round(workArea.x + (workArea.width - w) / 2);
  const y = config.data.overlay.y ?? workArea.y + workArea.height - h - 40;

  win = new BrowserWindow({
    x, y, width: w, height: h,
    minWidth: 460, minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true, // drag the edges while unlocked
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // above borderless-fullscreen games
  win.setIgnoreMouseEvents(config.data.overlay.locked, { forward: true });
  win.setOpacity(config.data.overlay.opacity);
  win.loadFile(join(ROOT, 'src', 'renderer', 'overlay.html'));

  win.on('moved', () => {
    if (!win) return;
    const [nx, ny] = win.getPosition();
    config.data.overlay.x = nx;
    config.data.overlay.y = ny;
    config.save();
  });
  win.on('resized', () => {
    if (!win) return;
    const [nw, nh] = win.getSize();
    config.data.overlay.width = nw;
    config.data.overlay.height = nh;
    config.save();
  });

  win.webContents.on('did-finish-load', () => {
    win?.webContents.setZoomFactor(config.data.overlay.scale);
    sendInit();
  });
}

// --- move browser window ---
function toggleMovesWindow() {
  if (movesWin && movesWin.isVisible()) { movesWin.hide(); return; }
  if (movesWin) { movesWin.show(); return; }
  movesWin = new BrowserWindow({
    width: 560,
    height: 780,
    minWidth: 400,
    minHeight: 320,
    title: `${charData.character} — move list`,
    frame: false, // custom title bar in moves.html
    backgroundColor: '#0b0f17',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  movesWin.loadFile(join(ROOT, 'src', 'renderer', 'moves.html'));
  movesWin.on('close', e => {
    if (!quitting) { e.preventDefault(); movesWin?.hide(); }
  });
  movesWin.on('closed', () => { movesWin = null; });
}

// --- settings window ---
function toggleSettingsWindow() {
  if (settingsWin && settingsWin.isVisible()) { settingsWin.hide(); return; }
  if (settingsWin) { settingsWin.show(); return; }
  settingsWin = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 380,
    minHeight: 400,
    title: 'Tekken Trainer — settings',
    frame: false, // custom title bar in settings.html
    backgroundColor: '#0b0f17',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(join(ROOT, 'src', 'renderer', 'settings.html'));
  settingsWin.on('close', e => {
    if (!quitting) { e.preventDefault(); settingsWin?.hide(); }
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

function sendConfig() {
  settingsWin?.webContents.send('config', config.data);
}

// start/stop the foreground watcher to match config
function updateGameWatch() {
  gameWatch?.stop();
  gameWatch = null;
  if (config.data.overlay.onlyOverGame) {
    gameWatch = new GameWatch(config.data.overlay.gameTitle);
    gameWatch.on('game', (foreground: boolean) => {
      if (foreground) win?.showInactive();
      else win?.hide();
    });
    gameWatch.start(500);
  } else {
    win?.showInactive();
  }
}

// live-apply a config edit coming from the settings window
function applyConfig(next: Partial<AppConfig>) {
  const prevHotkeys = JSON.stringify(config.data.hotkeys);
  const prevCharacter = config.data.character;
  config.replace(next);
  if (config.data.character !== prevCharacter) {
    loadCharacter(config.data.character);
    movesWin?.setTitle(`${charData.character} — move list`);
    sendMovesList();
  }
  poller.binds = config.data.binds;
  poller.side = config.data.side;
  notationDrill.setDifficulty(config.data.notation.difficulty);
  win?.setOpacity(config.data.overlay.opacity);
  win?.webContents.setZoomFactor(config.data.overlay.scale);
  if (JSON.stringify(config.data.hotkeys) !== prevHotkeys) registerHotkeys();
  updateGameWatch();
  sendInit();
  sendConfig(); // echo back so the pane reflects what was actually stored
}

function sendMovesList() {
  const entries = charData.moves.map((r: Record<string, unknown>) => {
    const m = compiled.get(r.id as string);
    return {
      id: r.id,
      name: r.name ?? null,
      command: r.command,
      tokens: m && !m.unrecognizable ? m.tokens : [],
      startup: r.startup ?? null,
      damage: r.damage ?? null,
      onBlock: r.onBlock ?? null,
      onHit: r.onHit ?? null,
      target: r.target ?? null,
      recognizable: !!m && !m.unrecognizable,
      reason: m?.unrecognizable ?? null,
    };
  });
  movesWin?.webContents.send('moves', { character: charData.character, entries });
}

ipcMain.on('moves-ready', () => sendMovesList());
ipcMain.on('moves-hide', () => movesWin?.hide());
ipcMain.on('open-settings', () => toggleSettingsWindow());
ipcMain.on('settings-ready', () => {
  settingsWin?.webContents.send('characters', listCharacters());
  sendConfig();
});
ipcMain.on('settings-hide', () => settingsWin?.hide());
ipcMain.on('set-config', (_e, next: Partial<AppConfig>) => applyConfig(next));
ipcMain.on('set-mode', () => actions.mode());
ipcMain.on('notation-skip', () => notationDrill.next());
ipcMain.on('notation-difficulty', (_e, d: AppConfig['notation']['difficulty']) => {
  notationDrill.setDifficulty(d);
  saveNotationDifficulty();
});
ipcMain.on('select-move', (_e, id: string) => {
  const m = compiled.get(id);
  if (!m || m.unrecognizable) return;
  trainer.setCustomDrill(buildDrillCombo(m));
  if (mode !== 'trainer') setMode('trainer');
  else { trainer.publish(); sendMetronome(); }
  movesWin?.webContents.send('selected', { id });
});

function currentAppearance(): { name: string; opacity: number; panelAlpha: number } | undefined {
  const { opacity, panelAlpha } = config.data.overlay;
  return config.data.overlay.appearancePresets.find(
    p => Math.abs(p.opacity - opacity) < 0.01 && Math.abs(p.panelAlpha - panelAlpha) < 0.01,
  );
}

function cycleAppearance() {
  const presets = config.data.overlay.appearancePresets;
  if (!presets.length) return;
  const cur = currentAppearance();
  const idx = cur ? presets.indexOf(cur) : -1; // hand-edited values resume from the top
  const next = presets[(idx + 1) % presets.length];
  config.data.overlay.opacity = next.opacity;
  config.data.overlay.panelAlpha = next.panelAlpha;
  config.save();
  win?.setOpacity(next.opacity);
  sendInit();
  sendConfig();
}

function sendInit() {
  win?.webContents.send('init', {
    mode,
    locked: config.data.overlay.locked,
    side: config.data.side,
    metronome: metronomeOn,
    opacity: config.data.overlay.opacity,
    panelAlpha: config.data.overlay.panelAlpha,
    appearanceName: currentAppearance()?.name ?? null,
    showKeys: config.data.overlay.showKeys,
    hotkeys: config.data.hotkeys,
  });
  if (mode === 'trainer') trainer.publish();
  if (mode === 'notation') notationDrill.publish();
  sendMetronome();
}

function sendMetronome() {
  win?.webContents.send('metronome', {
    on: metronomeOn && mode === 'trainer',
    beatsMs: trainer.metronomeBeats(),
    loopGapMs: 1200,
  });
}

function setMode(m: Mode) {
  mode = m;
  trainer.active = m === 'trainer';
  notationDrill.active = m === 'notation';
  if (m === 'trainer') trainer.resetAttempt();
  if (m === 'notation') notationDrill.next();
  sendInit();
}

function saveNotationDifficulty() {
  config.data.notation.difficulty = notationDrill.difficulty;
  config.save();
  sendConfig();
}

function setLocked(locked: boolean) {
  config.data.overlay.locked = locked;
  config.save();
  win?.setIgnoreMouseEvents(locked, { forward: true });
  win?.webContents.send('lock', { locked });
}

let gameWatch: GameWatch | null = null;

// hotkeys are user-editable in the settings window / config.json
// (Electron accelerator names); re-registered live when they change
const actions: Record<string, () => void> = {
  mode: () => setMode(mode === 'freeplay' ? 'trainer' : mode === 'trainer' ? 'notation' : 'freeplay'),
  prevCombo: () => {
    if (mode === 'notation') { notationDrill.cycleDifficulty(-1); saveNotationDifficulty(); }
    else { trainer.prev(); sendMetronome(); }
  },
  nextCombo: () => {
    if (mode === 'notation') { notationDrill.cycleDifficulty(1); saveNotationDifficulty(); }
    else { trainer.next(); sendMetronome(); }
  },
  lock: () => setLocked(!config.data.overlay.locked),
  moves: () => toggleMovesWindow(),
  side: () => {
    poller.side = poller.side === 'p1' ? 'p2' : 'p1';
    config.data.side = poller.side;
    config.save();
    sendInit();
    sendConfig();
  },
  metronome: () => { metronomeOn = !metronomeOn; sendInit(); },
  reset: () => { if (mode === 'notation') notationDrill.next(); else trainer.resetAttempt(); },
  opacity: () => cycleAppearance(),
  quit: () => app.quit(),
  help: () => {
    config.data.overlay.showKeys = !config.data.overlay.showKeys;
    config.save();
    sendInit();
  },
  settings: () => toggleSettingsWindow(),
};

function registerHotkeys() {
  globalShortcut.unregisterAll();
  for (const [action, handler] of Object.entries(actions)) {
    const accelerator = config.data.hotkeys[action];
    if (!accelerator) continue;
    try {
      if (!globalShortcut.register(accelerator, handler)) {
        console.warn(`hotkey ${accelerator} (${action}) is taken by another app`);
      }
    } catch {
      console.warn(`invalid hotkey "${accelerator}" for ${action} in config.json`);
    }
  }
}

app.whenReady().then(() => {
  createWindow();
  poller.start(2);
  trainer.active = mode === 'trainer';
  updateGameWatch();
  registerHotkeys();
});

ipcMain.on('renderer-ready', () => sendInit());

// --- dev hot reload (`npm run dev` passes --dev): reload open windows when
// renderer files change; loading re-sends all state. Main-process changes
// still need a restart.
if (process.argv.includes('--dev')) {
  let debounce: NodeJS.Timeout | null = null;
  const reload = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      win?.webContents.reloadIgnoringCache();
      movesWin?.webContents.reloadIgnoringCache();
    }, 150);
  };
  for (const dir of [join(ROOT, 'src', 'renderer'), join(ROOT, 'dist', 'renderer')]) {
    try { watch(dir, { recursive: true }, reload); } catch { /* dir may not exist until first build */ }
  }
}

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  poller.stop();
  gameWatch?.stop();
});
app.on('window-all-closed', () => app.quit());
