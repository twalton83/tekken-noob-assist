// Tekken notation compiler: turns Wavu command strings ("f,n,d,df:2", "ws1,3",
// "ZEN.1+2", "b+2,1") into step patterns the recognizer can match against raw
// controller input, plus display tokens for the overlay.

import type { Dir, Limb, DisplayToken } from './types';

export interface DirStep { kind: 'dir'; dir: Dir; hold: boolean }
export interface NeutralStep { kind: 'neutral' }
export interface PressStep {
  kind: 'press';
  buttons: Limb[];
  dir: Dir | null;      // null = direction not constrained (string continuations)
  holdDir: boolean;
  justFrame: boolean;   // ':' — dir and button on the same frame
  tight: boolean;       // '~' — must follow previous press almost immediately
}
export type Step = DirStep | NeutralStep | PressStep;

export type StateReq = 'ws' | 'FC' | 'OTG' | 'H' | 'R' | null;

export interface CompiledMove {
  id: string;
  name: string | null;
  command: string;
  state: StateReq;
  stance: string | null;        // stance prefix ('ZEN', 'KIN', 'NSS', ...) or null
  steps: Step[];                // full chain (parent steps + own)
  ownSteps: Step[];             // this move's continuation only
  parent: string | null;
  tokens: DisplayToken[];
  unrecognizable: string | null; // reason we can't detect it from input alone
}

const DIRS: Record<string, Dir> = {
  n: 'n', u: 'u', d: 'd', f: 'f', b: 'b',
  uf: 'uf', ub: 'ub', df: 'df', db: 'db',
};

const THROW_COMMANDS = new Set(['Left throw', 'Right throw', 'Back throw']);

export class NotationError extends Error {}

function parseDirToken(tok: string): { dir: Dir; hold: boolean } | null {
  const lower = tok.toLowerCase();
  if (!(lower in DIRS)) return null;
  const hold = tok !== lower || tok === tok.toUpperCase() && tok.length > 0 && /[A-Z]/.test(tok);
  return { dir: DIRS[lower], hold: /[A-Z]/.test(tok) };
}

// Parse one sub-segment like "f", "F", "n", "df:2", "b+1+2", "DF+4", "2", "1+2"
function parseSegment(seg: string, tight: boolean): Step {
  seg = seg.trim();
  if (!seg) throw new NotationError('empty segment');

  // just frame: dir:buttons
  const jf = seg.includes(':');
  const plusSplit = seg.split(jf ? ':' : '+');

  // pure direction?
  if (plusSplit.length === 1) {
    const d = parseDirToken(seg);
    if (d) {
      if (d.dir === 'n') return { kind: 'neutral' };
      return { kind: 'dir', dir: d.dir, hold: d.hold };
    }
    // pure buttons like "2" or (rare) "12"? buttons are always +-joined; single digit only
    if (/^[1-4]$/.test(seg)) {
      return { kind: 'press', buttons: [Number(seg) as Limb], dir: null, holdDir: false, justFrame: false, tight };
    }
    throw new NotationError(`unknown token "${seg}"`);
  }

  // dir+buttons or buttons only
  let dir: Dir | null = null;
  let holdDir = false;
  let idx = 0;
  const first = parseDirToken(plusSplit[0]);
  if (first) {
    dir = first.dir === 'n' ? null : first.dir;
    holdDir = first.hold;
    idx = 1;
    if (first.dir === 'n') dir = 'n';
  }
  const buttons: Limb[] = [];
  for (; idx < plusSplit.length; idx++) {
    const p = plusSplit[idx].trim();
    if (!/^[1-4]$/.test(p)) throw new NotationError(`bad button "${p}" in "${seg}"`);
    buttons.push(Number(p) as Limb);
  }
  if (buttons.length === 0) throw new NotationError(`no buttons in "${seg}"`);
  buttons.sort();
  return { kind: 'press', buttons, dir, holdDir, justFrame: jf, tight };
}

// Split a command body into steps. Commas separate steps; '~' separates but
// marks the following press as tight.
function parseBody(body: string): Step[] {
  const steps: Step[] = [];
  // normalize: commas and tildes both delimit; remember tightness
  const parts: { text: string; tight: boolean }[] = [];
  let cur = '';
  let tight = false;
  for (const ch of body) {
    if (ch === ',' || ch === '~') {
      if (cur.trim()) parts.push({ text: cur, tight });
      cur = '';
      tight = ch === '~';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push({ text: cur, tight });

  for (const p of parts) {
    // a mid-string state/stance prefix like "H.1+2" (df+2,H.1+2) or "NSS.1"
    // ("2,NSS.1"): strip and ignore it for matching (we can't verify heat, and
    // the mid-string stance is a consequence of the string, not an input).
    let text = p.text;
    const midState = text.match(/^((?:[A-Z][A-Za-z0-9]{0,3}\.)+)(.+)$/);
    if (midState && !parseDirToken(midState[1].slice(0, -1))) text = midState[2];
    steps.push(parseSegment(text, p.tight));
  }

  // Insert implicit neutral between consecutive same-direction steps
  // ("f,f" is physically f -> release -> f on a d-pad).
  const out: Step[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (
      prev && prev.kind === 'dir' && (
        (s.kind === 'dir' && s.dir === prev.dir) ||
        (s.kind === 'press' && s.dir === prev.dir && s.dir !== null)
      )
    ) {
      out.push({ kind: 'neutral' });
    }
    out.push(s);
  }
  return out;
}

// Plain-text Xbox-first label for people who don't read Tekken notation yet:
// "f,n,d,df+2" -> "→ N ↓ ↘+Y"
const GLYPH: Record<Dir, string> = {
  n: 'N', u: '↑', d: '↓', f: '→', b: '←', uf: '↗', ub: '↖', df: '↘', db: '↙',
};
const LIMB_LETTER: Record<number, string> = { 1: 'X', 2: 'Y', 3: 'A', 4: 'B' };

export function friendlyText(tokens: DisplayToken[]): string {
  return tokens.map(t => {
    if (t.kind === 'state') return `[${t.label}]`;
    if (t.kind === 'dir') return GLYPH[t.dir];
    const dir = t.dir ? GLYPH[t.dir] : '';
    const btns = t.limbs.map(l => LIMB_LETTER[l]).join('+');
    return `${t.tight ? '~' : ''}${dir}${dir ? (t.justFrame ? ':' : '+') : ''}${btns}`;
  }).join(' ');
}

export function stepsToTokens(steps: Step[]): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  for (const s of steps) {
    if (s.kind === 'neutral') tokens.push({ kind: 'dir', dir: 'n', hold: false });
    else if (s.kind === 'dir') tokens.push({ kind: 'dir', dir: s.dir, hold: s.hold });
    else tokens.push({ kind: 'btn', limbs: s.buttons, dir: s.dir === 'n' ? null : s.dir, holdDir: s.holdDir, justFrame: s.justFrame, tight: s.tight });
  }
  return tokens;
}

export interface RawMove {
  id: string;
  name: string | null;
  command: string;
  parent: string | null;
  notes: string | null;
}

// Compile one move given already-compiled parents (call in dependency order).
export function compileMove(raw: RawMove, parents: Map<string, CompiledMove>): CompiledMove {
  const base: CompiledMove = {
    id: raw.id,
    name: raw.name,
    command: raw.command,
    state: null,
    stance: null,
    steps: [],
    ownSteps: [],
    parent: raw.parent,
    tokens: [],
    unrecognizable: null,
  };

  if (THROW_COMMANDS.has(raw.command)) {
    base.unrecognizable = 'positional throw — no unique input';
    return base;
  }

  let body = raw.command.replace(/\$\{justFrame\}/g, ':');

  // Leading state/stance prefixes. States are the fixed set we can (partly)
  // verify from input; any other dotted prefix is a character stance (ZEN, KIN,
  // NSS, DGF, ...) — matched only while the recognizer assumes that stance.
  // Prefixes stack ("NSS.FC.DF+1", "NSS.IND.1"); the innermost stance wins,
  // since that's what the previous move's transition hint will have set.
  for (;;) {
    const m = body.match(/^(H|R|OTG|FC|hFC|CD)\./);
    if (m) {
      const p = m[1];
      body = body.slice(m[0].length);
      if (p === 'CD') body = 'f,n,d,' + body;   // crouch dash expansion
      else if (p === 'hFC') base.state = 'FC';  // half crouch ≈ full crouch
      else base.state = p as StateReq;
      continue;
    }
    const st = body.match(/^([A-Z][A-Z0-9]{1,3})\./);
    if (st) {
      base.stance = st[1];
      body = body.slice(st[0].length);
      continue;
    }
    if (/^ws/i.test(body)) {
      base.state = 'ws';
      body = body.slice(2);
      continue;
    }
    break;
  }

  // quarter circle motions ("qcb+1+3" and bare "qcb,f+2" both occur); '*' marks
  // a held/repeatable input and '*(n)' a mash count — drop both for matching
  body = body
    .replace(/^qcb/, 'd,db,b')
    .replace(/^qcf/, 'd,df,f')
    .replace(/\*\(\d+\)/g, '')
    .replace(/\*$/, '');

  let ownSteps: Step[];
  try {
    ownSteps = parseBody(body);
  } catch (e) {
    base.unrecognizable = e instanceof NotationError ? e.message : String(e);
    return base;
  }

  // String continuation: full steps = parent chain + own continuation.
  // (For child moves, wavu gives full command in id, e.g. "Jin-1,2,3" with
  // parent "Jin-1,2" — parseBody on the full command already yields the full
  // chain, so ownSteps here IS the full chain; derive the continuation.)
  base.steps = ownSteps;
  if (raw.parent && parents.has(raw.parent)) {
    const parent = parents.get(raw.parent)!;
    if (!parent.unrecognizable && parent.steps.length <= ownSteps.length) {
      base.ownSteps = ownSteps.slice(parent.steps.length);
    } else {
      base.ownSteps = ownSteps;
    }
  } else {
    base.ownSteps = ownSteps;
  }

  if (!base.steps.some(s => s.kind === 'press')) {
    base.unrecognizable = 'movement only — recognized as part of other moves';
  }

  base.tokens = [];
  if (base.state) base.tokens.push({ kind: 'state', label: base.state });
  if (base.stance) base.tokens.push({ kind: 'state', label: base.stance });
  base.tokens.push(...stepsToTokens(base.steps));
  return base;
}

// Compile a full move list (orders parents before children automatically).
export function compileAll(raws: RawMove[]): Map<string, CompiledMove> {
  const byId = new Map(raws.map(r => [r.id, r]));
  const compiled = new Map<string, CompiledMove>();
  const visit = (r: RawMove) => {
    if (compiled.has(r.id)) return;
    if (r.parent && byId.has(r.parent)) visit(byId.get(r.parent)!);
    compiled.set(r.id, compileMove(r, compiled));
  };
  raws.forEach(visit);
  return compiled;
}
