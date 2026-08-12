// Combo trainer: grades the timing of each input in a selected combo against
// frame-data-derived ideal offsets, and runs single-move / string drills for
// any move picked in the move browser.

import { EventEmitter } from 'node:events';
import { compileMove, friendlyText, stepsToTokens, type CompiledMove, type PressStep } from '../shared/notation';
import type { DisplayToken, Limb, RecognizedMoveMsg, TrainerStateMsg, TrainerStepState, TrainerVerdict } from '../shared/types';

const FRAME = 1000 / 60;

export interface ComboStepDef { command: string; ideal: number; window?: number }
export interface DrillStep { label: string; tokens: DisplayToken[]; buttons: Limb[] }
export interface ComboDef {
  id: string;
  name: string;
  kind?: 'sequence' | 'move-drill';
  note?: string;
  steps?: ComboStepDef[];
  moveId?: string;       // move-drill: target move
  altMoveId?: string;    // move-drill: sibling variant (jf <-> non-jf)
  drillSteps?: DrillStep[]; // move-drill: per-hit display cards
}

interface CompiledStep {
  def: ComboStepDef;
  buttons: Limb[];
  label: string;      // Xbox-first, notation in parens
  tokens: TrainerStepState['tokens'];
  window: number;
}

export type MoveLookup = (id: string) => CompiledMove | undefined;

export class Trainer extends EventEmitter {
  combos: ComboDef[];
  index = 0;
  active = false; // trainer mode on/off

  private getMove: MoveLookup;
  private steps: CompiledStep[] = [];
  private verdicts: { verdict: TrainerVerdict; delta: number | null }[] = [];
  private attemptStart: number | null = null;
  private stepIdx = 0;
  private lastSummary: string | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private clearTimer: NodeJS.Timeout | null = null;
  private drillStats = { lastGapMs: null as number | null, electric: null as boolean | null, attempts: 0, electrics: 0 };
  private drillProgress = 0;
  private drillHitTimes: number[] = [];

  constructor(combos: ComboDef[], getMove: MoveLookup = () => undefined) {
    super();
    this.combos = combos;
    this.getMove = getMove;
    this.selectCombo(0);
  }

  get current(): ComboDef { return this.combos[this.index]; }

  // Replace/insert the "picked from the move browser" drill and select it.
  setCustomDrill(def: ComboDef) {
    const existing = this.combos.findIndex(c => c.id.startsWith('custom:'));
    if (existing >= 0) this.combos.splice(existing, 1, def);
    else this.combos.unshift(def);
    this.selectCombo(this.combos.indexOf(def));
  }

  selectCombo(i: number) {
    this.index = ((i % this.combos.length) + this.combos.length) % this.combos.length;
    const combo = this.current;
    this.steps = [];
    if ((combo.kind ?? 'sequence') === 'sequence') {
      for (const sd of combo.steps ?? []) {
        const compiled: CompiledMove = compileMove(
          { id: `combo-${sd.command}`, name: null, command: sd.command, parent: null, notes: null },
          new Map(),
        );
        const presses = compiled.steps.filter(s => s.kind === 'press') as PressStep[];
        const lastPress = presses[presses.length - 1];
        const tokens = compiled.unrecognizable ? [] : stepsToTokens(compiled.steps);
        this.steps.push({
          def: sd,
          buttons: lastPress ? lastPress.buttons : [],
          label: tokens.length ? `${friendlyText(tokens)} (${sd.command})` : sd.command,
          tokens,
          window: sd.window ?? 3,
        });
      }
    } else if (combo.drillSteps) {
      for (const ds of combo.drillSteps) {
        this.steps.push({
          def: { command: ds.label, ideal: 0 },
          buttons: ds.buttons,
          label: ds.label,
          tokens: ds.tokens,
          window: 0,
        });
      }
    }
    this.resetAttempt(false);
    this.lastSummary = null;
    this.drillStats = { lastGapMs: null, electric: null, attempts: 0, electrics: 0 };
    this.publish();
  }

  next() { this.selectCombo(this.index + 1); }
  prev() { this.selectCombo(this.index - 1); }

  resetAttempt(publish = true) {
    this.attemptStart = null;
    this.stepIdx = 0;
    this.drillProgress = 0;
    this.drillHitTimes = [];
    this.verdicts = this.steps.map(() => ({ verdict: 'pending' as TrainerVerdict, delta: null }));
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    if (publish) this.publish();
  }

  // Sequence combos consume raw press events (buttons + timestamp).
  onPress(t: number, buttons: Limb[]) {
    if (!this.active || (this.current.kind ?? 'sequence') !== 'sequence' || this.steps.length === 0) return;
    const key = buttons.join('+');

    if (this.attemptStart === null) {
      if (key !== this.steps[0].buttons.join('+')) {
        // wrong opener: flag it instead of waiting silently
        this.verdicts[0] = { verdict: 'wrong', delta: null };
        this.publish();
        this.armClear();
        return;
      }
      if (this.clearTimer) clearTimeout(this.clearTimer); // don't wipe the new attempt
      this.clearTimer = null;
      this.verdicts = this.steps.map(() => ({ verdict: 'pending' as TrainerVerdict, delta: null }));
      this.attemptStart = t;
      this.verdicts[0] = { verdict: 'good', delta: 0 };
      this.stepIdx = 1;
      this.armTimeout();
      if (this.steps.length === 1) this.finishAttempt();
      this.publish();
      return;
    }

    if (this.stepIdx >= this.steps.length) return;
    const step = this.steps[this.stepIdx];
    if (key !== step.buttons.join('+')) {
      this.verdicts[this.stepIdx] = { verdict: 'wrong', delta: null };
      this.publish();
      return; // stay on this step; let them continue
    }
    const deltaFrames = (t - this.attemptStart) / FRAME - step.def.ideal;
    let verdict: TrainerVerdict = 'good';
    if (deltaFrames < -step.window) verdict = 'early';
    else if (deltaFrames > step.window) verdict = 'late';
    this.verdicts[this.stepIdx] = { verdict, delta: deltaFrames };
    this.stepIdx++;
    if (this.stepIdx >= this.steps.length) this.finishAttempt();
    else this.publish();
  }

  // Move drills consume recognizer output.
  onMove(msg: RecognizedMoveMsg) {
    if (!this.active) return;
    const combo = this.current;
    if ((combo.kind ?? 'sequence') !== 'move-drill' || !combo.moveId) return;

    const target = this.getMove(combo.moveId);
    const isJf = combo.moveId.includes(':') || (combo.altMoveId ?? '').includes(':');

    if (msg.id === combo.moveId || msg.id === combo.altMoveId) {
      // completed (for jf targets: attempted — electric flag says if it landed)
      this.drillHitTimes.push(msg.t);
      this.drillStats.attempts++;
      this.drillStats.lastGapMs = msg.jfGapMs;
      this.drillStats.electric = msg.electric;
      if (msg.electric) this.drillStats.electrics++;
      const success = !isJf || msg.electric === true;
      this.verdicts = this.verdicts.map(() => ({ verdict: (success ? 'good' : 'late') as TrainerVerdict, delta: null }));

      if (isJf) {
        const gap = msg.jfGapMs === null ? '' : ` (df→2 gap ${msg.jfGapMs.toFixed(1)}ms)`;
        this.lastSummary = msg.electric
          ? `⚡ ELECTRIC!${gap} — ${this.drillStats.electrics}/${this.drillStats.attempts}`
          : `Regular version${gap} — press the button on the SAME frame as ↘. ${this.drillStats.electrics}/${this.drillStats.attempts}`;
      } else {
        const gaps = this.drillHitTimes.slice(1).map((t, i) => ((t - this.drillHitTimes[i]) / FRAME).toFixed(1));
        this.lastSummary = `Hit! ×${this.drillStats.attempts}${gaps.length ? ` — gaps ${gaps.join('f, ')}f` : ''}`;
      }
      this.drillProgress = 0;
      this.drillHitTimes = [];
      this.publish();
      this.armClear();
      return;
    }

    // partial progress through a string toward the target
    if (target && this.cmdIsPrefix(msg.command, target.command)) {
      const emitted = this.getMove(msg.id);
      const k = emitted ? emitted.steps.filter(s => s.kind === 'press').length : 1;
      if (k <= this.drillProgress) this.drillHitTimes = []; // restarted the string
      this.drillProgress = k;
      this.drillHitTimes.push(msg.t);
      this.verdicts = this.steps.map((_, i) => ({
        verdict: (i < k ? 'good' : 'pending') as TrainerVerdict, delta: null,
      }));
      this.publish();
    }
  }

  private cmdIsPrefix(shorter: string, longer: string): boolean {
    if (!longer.startsWith(shorter)) return false;
    const next = longer[shorter.length];
    return next === ',' || next === '~';
  }

  private armClear() {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => {
      this.verdicts = this.steps.map(() => ({ verdict: 'pending' as TrainerVerdict, delta: null }));
      this.publish();
    }, 4000);
  }

  private armTimeout() {
    const last = this.steps[this.steps.length - 1];
    const ms = (last.def.ideal + 90) * FRAME;
    this.timeoutTimer = setTimeout(() => {
      for (let i = this.stepIdx; i < this.verdicts.length; i++) {
        if (this.verdicts[i].verdict === 'pending') this.verdicts[i] = { verdict: 'missed', delta: null };
      }
      this.finishAttempt();
    }, ms);
  }

  private finishAttempt() {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    const parts: string[] = [];
    let good = 0;
    this.verdicts.forEach((v, i) => {
      if (v.verdict === 'good') { good++; return; }
      const label = this.steps[i].label;
      if (v.verdict === 'early') parts.push(`${label}: ${Math.abs(v.delta!).toFixed(1)}f early`);
      else if (v.verdict === 'late') parts.push(`${label}: ${v.delta!.toFixed(1)}f late`);
      else if (v.verdict === 'missed') parts.push(`${label}: missed`);
      else if (v.verdict === 'wrong') parts.push(`${label}: wrong button`);
    });
    this.lastSummary = parts.length === 0
      ? `Clean! all ${good} inputs on time`
      : parts.join('  ·  ');
    this.attemptStart = null;
    this.stepIdx = 0;
    this.publish();
    this.armClear();
  }

  metronomeBeats(): number[] {
    if ((this.current.kind ?? 'sequence') !== 'sequence') return [];
    return (this.current.steps ?? []).map(s => s.ideal * FRAME);
  }

  publish() {
    const combo = this.current;
    const steps: TrainerStepState[] = this.steps.map((s, i) => ({
      label: s.label,
      tokens: s.tokens,
      idealFrame: s.def.ideal,
      windowFrames: s.window,
      verdict: this.verdicts[i]?.verdict ?? 'pending',
      deltaFrames: this.verdicts[i]?.delta ?? null,
    }));
    const msg: TrainerStateMsg = {
      comboId: combo.id,
      comboName: combo.name,
      comboIndex: this.index,
      comboCount: this.combos.length,
      note: combo.note ?? null,
      kind: combo.kind ?? 'sequence',
      steps,
      attemptActive: this.attemptStart !== null,
      lastSummary: this.lastSummary,
      drill: (combo.kind === 'move-drill') ? { ...this.drillStats } : undefined,
    };
    this.emit('state', msg);
  }
}
