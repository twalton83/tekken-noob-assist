// Move recognizer: consumes timestamped pad samples, produces recognized moves.
// Pure input-side logic — it knows what you pressed, never what the game did.

import { EventEmitter } from 'node:events';
import type { CompiledMove, PressStep, Step } from '../shared/notation';
import type { Dir, Limb, RecognizedMoveMsg } from '../shared/types';
import type { PadSample } from './xinput';

const FRAME = 1000 / 60;

interface DirInterval { dir: Dir; from: number; to: number } // to = Infinity while active
interface PressEvent { t: number; buttons: Limb[]; dir: Dir; dirSince: number }

interface Candidate { move: CompiledMove; score: number; jfGapMs: number | null }

const CHORD_MERGE_MS = 18;       // presses within ~1 frame count as a chord
const DIR_SEQ_WINDOW_MS = 700;   // whole motion (f,n,d,df) must fit in this
const STRING_WINDOW_MS = 1200;   // max gap to continue a string
const STANCE_PREF_MS = 500;      // after this gap, prefer stance move over string
const TIGHT_WINDOW_MS = 8 * FRAME;
const WS_WINDOW_MS = 14 * FRAME; // press after crouch-release counts as ws
const CROUCH_MIN_MS = 10 * FRAME;
const STANCE_TTL_MS = 4000;

export class Recognizer extends EventEmitter {
  private dirHistory: DirInterval[] = [{ dir: 'n', from: 0, to: Infinity }];
  private heldLimbs = new Set<Limb>();
  private pendingPress: { t: number; buttons: Set<Limb> } | null = null;
  private lastMove: { move: CompiledMove; t: number } | null = null;
  private assumedStance: { name: string; until: number } | null = null;

  private moves: CompiledMove[] = [];
  private children = new Map<string, CompiledMove[]>();       // parent id -> children
  private freshByButtons = new Map<string, CompiledMove[]>(); // "1+2" -> root moves ending in that press

  constructor(moves: Map<string, CompiledMove>) {
    super();
    const recognizable = [...moves.values()].filter(m => !m.unrecognizable);
    this.moves = recognizable;

    // Index every move by its full step signature so multi-hit strings can find
    // their true parent even when wavu's parent link skips a level ("2,1,4~4"
    // -> parent "Jin-2,1") or is missing entirely ("4~3").
    const serialize = (m: CompiledMove, steps: Step[]) =>
      `${m.state ?? ''}|${m.stance ?? ''}|` + steps.map(s =>
        s.kind === 'neutral' ? 'n' :
        s.kind === 'dir' ? `d:${s.dir}${s.hold ? 'H' : ''}` :
        `p:${s.dir ?? '*'}${s.holdDir ? 'H' : ''}${s.justFrame ? ':' : ''}${s.buttons.join('+')}`
      ).join(',');
    const bySig = new Map<string, CompiledMove>();
    for (const m of recognizable) bySig.set(serialize(m, m.steps), m);

    for (const m of recognizable) {
      const pressIdxs = m.steps
        .map((s, i) => (s.kind === 'press' ? i : -1))
        .filter(i => i >= 0);
      if (pressIdxs.length === 0) continue;

      let parent: CompiledMove | undefined;
      if (pressIdxs.length > 1) {
        const lastPressIdx = pressIdxs[pressIdxs.length - 1];
        parent = bySig.get(serialize(m, m.steps.slice(0, lastPressIdx)));
        if (parent) {
          m.ownSteps = m.steps.slice(lastPressIdx); // exactly the last press
          const list = this.children.get(parent.id) ?? [];
          list.push(m);
          this.children.set(parent.id, list);
        }
      }
      if (!parent && pressIdxs.length > 1) continue; // unreachable mid-string; skip
      if (!parent) {
        // root move: index by its first press buttons
        const key = (m.steps[pressIdxs[0]] as PressStep).buttons.join('+');
        const list = this.freshByButtons.get(key) ?? [];
        list.push(m);
        this.freshByButtons.set(key, list);
      }
    }
  }

  feed(s: PadSample) {
    // direction tracking
    const cur = this.dirHistory[this.dirHistory.length - 1];
    if (s.dir !== cur.dir) {
      cur.to = s.t;
      this.dirHistory.push({ dir: s.dir, from: s.t, to: Infinity });
      if (this.dirHistory.length > 200) this.dirHistory.splice(0, 100);
    }

    // new limb presses (rising edge)
    const newly: Limb[] = [];
    for (const l of s.limbs) if (!this.heldLimbs.has(l)) newly.push(l);
    this.heldLimbs = new Set(s.limbs);

    if (newly.length) {
      if (this.pendingPress && s.t - this.pendingPress.t <= CHORD_MERGE_MS) {
        newly.forEach(l => this.pendingPress!.buttons.add(l));
      } else {
        this.flushPending(s.t);
        this.pendingPress = { t: s.t, buttons: new Set(newly) };
      }
    }
    // flush a pending chord once the merge window has passed
    if (this.pendingPress && s.t - this.pendingPress.t > CHORD_MERGE_MS) this.flushPending(s.t);
  }

  private flushPending(_now: number) {
    if (!this.pendingPress) return;
    const p = this.pendingPress;
    this.pendingPress = null;
    const iv = this.dirIntervalAt(p.t);
    const ev: PressEvent = {
      t: p.t,
      buttons: [...p.buttons].sort() as Limb[],
      dir: iv.dir,
      dirSince: iv.from,
    };
    this.onPress(ev);
  }

  private dirIntervalAt(t: number): DirInterval {
    for (let i = this.dirHistory.length - 1; i >= 0; i--) {
      const iv = this.dirHistory[i];
      if (iv.from <= t && t < iv.to + 0.001 || iv.to === Infinity && iv.from <= t) return iv;
    }
    return this.dirHistory[this.dirHistory.length - 1];
  }

  private onPress(ev: PressEvent) {
    const cont = this.tryStringContinuation(ev);
    const cands = this.matchFresh(ev).sort((a, b) => b.score - a.score);
    const label = (c: Candidate) => `${c.move.command}${c.move.name ? ` — ${c.move.name}` : ''}`;

    // A stance move (ZEN.1) and a string continuation (f+3,1) can share an
    // input; a quick press is the string, a delayed one the stance move.
    const stanceBest = cands.find(c =>
      c.move.stance && this.assumedStance?.name === c.move.stance && ev.t <= this.assumedStance.until);
    if (cont && stanceBest && ev.t - (this.lastMove?.t ?? 0) > STANCE_PREF_MS) {
      this.emitMove(stanceBest, ev, false, [label(cont)]);
      return;
    }
    if (cont) {
      this.emitMove(cont, ev, true, stanceBest ? [label(stanceBest)] : []);
      return;
    }
    if (cands.length === 0) {
      this.emit('unmatched', ev);
      return;
    }
    const best = cands[0];
    const alternates = cands
      .filter(c => c !== best && c.score === best.score)
      .map(label);
    this.emitMove(best, ev, false, alternates);
  }

  private emitMove(c: Candidate, ev: PressEvent, isString: boolean, alternates: string[] = []) {
    this.lastMove = { move: c.move, t: ev.t };

    // stance transitions: a move whose notes/name mention entering ZEN/DVS sets
    // assumed stance (data-driven via `stanceHints` set at load time)
    const hint = (c.move as CompiledMove & { stanceHint?: string }).stanceHint;
    if (hint) this.assumedStance = { name: hint, until: ev.t + STANCE_TTL_MS };
    else this.assumedStance = null; // any attack (stance or not) drops the assumed stance

    const electric = c.move.steps.some(s => s.kind === 'press' && s.justFrame)
      ? true
      : c.jfGapMs !== null ? false : null;

    const msg: RecognizedMoveMsg = {
      id: c.move.id,
      name: c.move.name,
      command: c.move.command,
      tokens: c.move.tokens,
      approximate: !!c.move.stance || c.move.state === 'H' || c.move.state === 'R' || c.move.state === 'OTG',
      alternates,
      jfGapMs: c.jfGapMs,
      electric,
      t: ev.t,
    };
    this.emit('move', msg, { isString });
  }

  private tryStringContinuation(ev: PressEvent): Candidate | null {
    if (!this.lastMove) return null;
    const gap = ev.t - this.lastMove.t;
    if (gap > STRING_WINDOW_MS) return null;
    const kids = this.children.get(this.lastMove.move.id);
    if (!kids) return null;
    for (const kid of kids) {
      const cont = kid.ownSteps.filter(s => s.kind === 'press') as PressStep[];
      if (cont.length !== 1) continue; // continuations are single presses in this data
      const step = cont[0];
      if (step.buttons.join('+') !== ev.buttons.join('+')) continue;
      if (step.tight && gap > TIGHT_WINDOW_MS) continue;
      if (step.dir && step.dir !== 'n' && ev.dir !== step.dir) continue;
      return { move: kid, score: 100, jfGapMs: null };
    }
    return null;
  }

  private matchFresh(ev: PressEvent): Candidate[] {
    const key = ev.buttons.join('+');
    const pool = this.freshByButtons.get(key) ?? [];
    const out: Candidate[] = [];
    for (const m of pool) {
      const c = this.matchMove(m, ev);
      if (c) out.push(c);
    }
    if (out.length) return out;

    // fallback: direction held but no dir-specific move exists (e.g. holding f
    // and pressing 1 -> jab). Retry ignoring the direction requirement.
    for (const m of pool.length ? [] : this.freshByButtons.get(key) ?? []) void m;
    const relaxed: Candidate[] = [];
    for (const m of this.freshByButtons.get(key) ?? []) {
      const press = m.steps.filter(s => s.kind === 'press');
      const dirSteps = m.steps.filter(s => s.kind !== 'press');
      if (press.length && dirSteps.length === 0 && !m.state && !m.stance) {
        const p = press[0] as PressStep;
        if (p.dir === null || p.dir === 'n') relaxed.push({ move: m, score: 0, jfGapMs: null });
      }
    }
    return relaxed;
  }

  private matchMove(m: CompiledMove, ev: PressEvent): Candidate | null {
    // stance moves only match while we assume that stance
    if (m.stance) {
      if (!this.assumedStance || this.assumedStance.name !== m.stance || ev.t > this.assumedStance.until) return null;
    }
    // ws / FC state checks
    if (m.state === 'ws' && !this.wasStandingUp(ev)) return null;
    if (m.state === 'FC' && !this.inFullCrouch(ev)) return null;

    const stepsBeforePress: Step[] = [];
    let firstPress: PressStep | null = null;
    for (const s of m.steps) {
      if (s.kind === 'press') { firstPress = s; break; }
      stepsBeforePress.push(s);
    }
    if (!firstPress) return null;

    // direction requirement at press time
    let jfGapMs: number | null = null;
    if (firstPress.justFrame) {
      if (ev.dir !== firstPress.dir) return null;
      jfGapMs = ev.t - ev.dirSince;
      if (jfGapMs > FRAME) return null; // not the just-frame version
    } else if (firstPress.dir && firstPress.dir !== 'n') {
      if (ev.dir !== firstPress.dir) return null;
      // if a just-frame sibling exists it will claim same-frame presses; also
      // measure the gap so the UI can report near-electrics
      jfGapMs = ev.t - ev.dirSince;
      if (this.hasJustFrameSibling(m) && jfGapMs <= FRAME) return null;
      if (!this.hasJustFrameSibling(m)) jfGapMs = null;
    } else if (firstPress.dir === 'n' || (firstPress.dir === null && stepsBeforePress.length === 0 && !m.state && !m.stance)) {
      if (ev.dir !== 'n' && firstPress.dir === 'n') return null;
      if (firstPress.dir === null && ev.dir !== 'n') return null; // plain "1" needs neutral
    }

    // match direction sequence backwards through history
    if (stepsBeforePress.length) {
      if (!this.matchDirSequence(stepsBeforePress, ev)) return null;
    }

    let score = 1 + stepsBeforePress.length * 10;
    if (firstPress.dir) score += 2;
    if (firstPress.justFrame) score += 5;
    if (m.state) score += 3;
    if (m.stance) score += 4;
    return { move: m, score, jfGapMs };
  }

  private hasJustFrameSibling(m: CompiledMove): boolean {
    // e.g. CD.df+2 has sibling CD.df:2
    return this.moves.some(o =>
      o !== m && o.command.replace(':', '+') === m.command && o.command.includes(':'));
  }

  private matchDirSequence(steps: Step[], ev: PressEvent): boolean {
    // walk dir history backwards from the interval before the press interval,
    // matching steps in reverse; skip micro-intervals (< 25ms) from d-pad rolls
    let hIdx = this.dirHistory.length - 1;
    while (hIdx >= 0 && this.dirHistory[hIdx].from > ev.dirSince - 0.001) hIdx--;
    // dirHistory[hIdx] is now the interval before the one active at press

    let sIdx = steps.length - 1;
    let skips = 0;
    const earliestAllowed = ev.t - DIR_SEQ_WINDOW_MS;
    while (sIdx >= 0 && hIdx >= 0) {
      const iv = this.dirHistory[hIdx];
      if (iv.to !== Infinity && iv.to < earliestAllowed) return false;
      const step = steps[sIdx];
      const want: Dir = step.kind === 'neutral' ? 'n' : (step as { dir: Dir }).dir;
      if (iv.dir === want) { sIdx--; hIdx--; continue; }
      const dur = (iv.to === Infinity ? ev.t : iv.to) - iv.from;
      if (dur < 25 && skips < 3) { skips++; hIdx--; continue; }
      return false;
    }
    return sIdx < 0;
  }

  private wasStandingUp(ev: PressEvent): boolean {
    // crouched (d/db/df) for >= CROUCH_MIN_MS, then released to n/f within WS_WINDOW_MS
    if (ev.dir !== 'n' && ev.dir !== 'f') return false;
    if (ev.t - ev.dirSince > WS_WINDOW_MS) return false;
    let crouchMs = 0;
    for (let i = this.dirHistory.length - 1; i >= 0; i--) {
      const iv = this.dirHistory[i];
      if (iv.from >= ev.dirSince) continue;
      const isCrouch = iv.dir === 'd' || iv.dir === 'db' || iv.dir === 'df';
      if (!isCrouch) break;
      crouchMs += (iv.to === Infinity ? ev.t : Math.min(iv.to, ev.dirSince)) - iv.from;
      if (crouchMs >= CROUCH_MIN_MS) return true;
    }
    return false;
  }

  private inFullCrouch(ev: PressEvent): boolean {
    // has been holding a crouch direction for a while (press dir df counts)
    let crouchMs = 0;
    for (let i = this.dirHistory.length - 1; i >= 0; i--) {
      const iv = this.dirHistory[i];
      const isCrouch = iv.dir === 'd' || iv.dir === 'db' || iv.dir === 'df';
      if (!isCrouch) break;
      crouchMs += (iv.to === Infinity ? ev.t : iv.to) - iv.from;
      if (crouchMs >= CROUCH_MIN_MS * 2) return true;
    }
    return false;
  }
}

// Attach stance-entry hints from move notes/names ("...transition to ZEN...")
// plus curated overrides from data/stances.json (wavu notes are incomplete).
export function annotateStanceHints(
  moves: Map<string, CompiledMove>,
  raws: { id: string; notes: string | null; name: string | null }[],
  overrides: Record<string, string[]> = {},
) {
  for (const r of raws) {
    const m = moves.get(r.id);
    if (!m || m.unrecognizable) continue;
    const text = `${r.notes ?? ''} ${r.name ?? ''}`;
    for (const stance of ['ZEN', 'DVS']) {
      if (m.stance === stance) continue; // a stance move doesn't (re-)enter it
      const re = new RegExp(`(to|into|enter[s]?)\\s+${stance}|${stance}\\s*(transition|cancel)`, 'i');
      if (re.test(text)) (m as CompiledMove & { stanceHint?: string }).stanceHint = stance;
    }
  }
  for (const [stance, ids] of Object.entries(overrides)) {
    if (stance.startsWith('_')) continue;
    for (const id of ids) {
      const m = moves.get(id);
      if (m && !m.unrecognizable) (m as CompiledMove & { stanceHint?: string }).stanceHint = stance;
    }
  }
}
