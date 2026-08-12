// Shared types between main (engine) and renderer (overlay UI).

export type Dir = 'n' | 'u' | 'd' | 'f' | 'b' | 'uf' | 'ub' | 'df' | 'db';
export type Limb = 1 | 2 | 3 | 4; // Tekken limbs: 1=LP 2=RP 3=LK 4=RK

// Tokens the renderer turns into arrows / button icons.
export type DisplayToken =
  | { kind: 'dir'; dir: Dir; hold: boolean }
  | { kind: 'btn'; limbs: Limb[]; dir: Dir | null; holdDir: boolean; justFrame: boolean; tight: boolean }
  | { kind: 'state'; label: string }; // ws, FC, ZEN, H, ...

export interface RecognizedMoveMsg {
  id: string;
  name: string | null;
  command: string;        // wavu notation
  tokens: DisplayToken[];
  approximate: boolean;   // matched using assumed state (stance/heat) we can't verify
  alternates: string[];   // same-input moves in other states (e.g. "H.2+3 Heat Smash")
  jfGapMs: number | null; // for just-frame moves: measured gap dir->button
  electric: boolean | null; // CD.df:X detection: true = just frame achieved
  t: number;
}

export type TrainerVerdict = 'good' | 'early' | 'late' | 'wrong' | 'missed' | 'pending';

export interface TrainerStepState {
  label: string;          // notation for this step
  tokens: DisplayToken[];
  idealFrame: number;     // offset from first input, in frames (60fps)
  windowFrames: number;
  verdict: TrainerVerdict;
  deltaFrames: number | null; // negative = early, positive = late
}

export interface TrainerStateMsg {
  comboId: string;
  comboName: string;
  comboIndex: number;
  comboCount: number;
  note: string | null;
  kind: 'sequence' | 'move-drill';
  steps: TrainerStepState[];
  attemptActive: boolean;
  lastSummary: string | null;  // human line after an attempt
  drill?: { lastGapMs: number | null; electric: boolean | null; attempts: number; electrics: number };
}

export interface PadStateMsg {
  dir: Dir;
  buttons: Limb[]; // currently held limb buttons
  connected: boolean;
}

// One entry in the Tekken-style input history strip.
export interface InputEventMsg {
  kind: 'dir' | 'press';
  dir: Dir;
  buttons: Limb[]; // empty for pure direction events
  t: number;
}

export type Mode = 'freeplay' | 'trainer' | 'notation';

// ---- notation drill (read notation → input it) ----
export type NotationDifficulty = 'easy' | 'medium' | 'hard';

export interface NotationStateMsg {
  command: string;      // the prompt, in notation — icons are the answer, so they're only in feedback
  stepCount: number;
  stepIndex: number;    // how many steps have been entered correctly
  feedback: null | {
    kind: 'correct' | 'wrong';
    expectedTokens: DisplayToken[]; // the reveal
    gotTokens?: DisplayToken[];     // what was actually pressed (wrong only)
  };
  streak: number;
  hits: number;
  total: number;
  difficulty: NotationDifficulty;
}

// One row in the move browser window.
export interface MoveListEntry {
  id: string;
  name: string | null;
  command: string;
  tokens: DisplayToken[];
  startup: string | null;
  damage: string | null;
  onBlock: string | null;
  onHit: string | null;
  target: string | null;      // hit levels: h/m/l
  recognizable: boolean;
  reason: string | null;      // why not recognizable
}

export interface OverlayInit {
  mode: Mode;
  locked: boolean;
  side: 'p1' | 'p2';
  metronome: boolean;
  opacity: number;
  panelAlpha: number;
  appearanceName: string | null; // matching preset name, e.g. "solid"
  showKeys: boolean;
  hotkeys: Record<string, string>;
}

// Full user config shape — persisted by main (config.json), edited live by the
// settings window.
export interface AppConfig {
  _doc: string;
  character: string; // which data/<character>.json to train with
  binds: Record<string, Limb[]>;
  side: 'p1' | 'p2';
  overlay: {
    x: number | null; y: number | null;
    width: number; height: number;
    locked: boolean; opacity: number; showKeys: boolean;
    onlyOverGame: boolean; // hide the overlay unless the game window is focused
    gameTitle: string;     // substring matched against the foreground window title
    scale: number;        // zooms the whole overlay (1 = 100%)
    panelAlpha: number;   // darkness of the glass panel, 0..1 (1 = solid)
    // the appearance-hotkey cycle; each preset sets window opacity + glass darkness
    appearancePresets: { name: string; opacity: number; panelAlpha: number }[];
  };
  hotkeys: Record<string, string>;
  notation: { difficulty: NotationDifficulty };
}

export interface MetronomeMsg {
  on: boolean;
  beatsMs: number[];   // tick offsets within one loop
  loopGapMs: number;
}
