// Notation drill: shows a random command in Tekken notation (text only — the
// button icons are the answer) and grades the player's actual inputs against
// it. No timing pressure; this trains notation reading, not execution speed.

import { EventEmitter } from 'node:events';
import type { Dir, DisplayToken, Limb, NotationDifficulty, NotationStateMsg } from '../shared/types';

interface Step { dir: Dir; limbs: Limb[] }

const DIFFS: NotationDifficulty[] = ['easy', 'medium', 'hard'];
const DIRS: Dir[] = ['f', 'b', 'd', 'df', 'db', 'uf'];
const LIMBS: Limb[] = [1, 2, 3, 4];
const CHORDS: Limb[][] = [[1, 2], [3, 4], [1, 3], [2, 4], [2, 3]];
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

const REVEAL_MS = { correct: 800, wrong: 1500 };
const RETRY_GRACE_MS = 300; // ignore stray presses right after a wrong verdict

export class NotationDrill extends EventEmitter {
  active = false;
  difficulty: NotationDifficulty = 'easy';

  private steps: Step[] = [];
  private command = '';
  private idx = 0;
  private streak = 0;
  private hits = 0;
  private total = 0;
  private feedback: NotationStateMsg['feedback'] = null;
  private waitTimer: NodeJS.Timeout | null = null;
  private resume: (() => void) | null = null; // set when a press may end the pause early
  private pausedAt = 0;

  /** Fresh prompt (used on mode entry and for skip). */
  next() {
    this.generate();
    this.publish();
  }

  setDifficulty(d: NotationDifficulty) {
    if (!DIFFS.includes(d) || d === this.difficulty) return;
    this.difficulty = d;
    this.next();
  }

  cycleDifficulty(delta: number) {
    const i = DIFFS.indexOf(this.difficulty);
    this.setDifficulty(DIFFS[(i + delta + DIFFS.length) % DIFFS.length]);
  }

  onPress(limbs: Limb[], dir: Dir, t: number) {
    if (!this.active) return;
    if (this.waitTimer) {
      // after a wrong verdict, a retry press ends the reveal early and gets
      // graded — otherwise it would be eaten and the NEXT press would be
      // graded against the wrong step. Correct-reveal still swallows presses
      // (the next prompt isn't visible yet).
      if (!this.resume || t - this.pausedAt < RETRY_GRACE_MS) return;
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
      const r = this.resume;
      this.resume = null;
      r();
    }
    const expected = this.steps[this.idx];
    if (!expected) return;
    const ok = dir === expected.dir
      && limbs.length === expected.limbs.length
      && limbs.every((l, i) => l === expected.limbs[i]); // both sorted

    if (!ok) {
      this.total++;
      this.streak = 0;
      this.feedback = {
        kind: 'wrong',
        expectedTokens: this.tokens(this.steps),
        gotTokens: this.tokens([{ dir, limbs }]),
      };
      this.publish();
      // retry the same prompt until it's entered correctly
      this.pausedAt = t;
      this.pause(REVEAL_MS.wrong, () => { this.idx = 0; this.feedback = null; }, true);
      return;
    }

    this.idx++;
    if (this.idx < this.steps.length) { this.publish(); return; }
    this.total++;
    this.hits++;
    this.streak++;
    this.feedback = { kind: 'correct', expectedTokens: this.tokens(this.steps) };
    this.publish();
    this.pause(REVEAL_MS.correct, () => this.generate());
  }

  private pause(ms: number, then: () => void, resumeOnInput = false) {
    this.resume = resumeOnInput ? then : null;
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      this.resume = null;
      then();
      this.publish();
    }, ms);
  }

  private generate() {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.resume = null;
    const count = this.difficulty === 'easy' ? 1 : this.difficulty === 'medium' ? 2 : 3;
    const prev = this.command;
    do {
      this.steps = [];
      for (let i = 0; i < count; i++) {
        // first inputs lean on directions/chords; later hits in a string are mostly plain buttons
        const limbs = Math.random() < (i === 0 ? 0.25 : 0.15) ? [...pick(CHORDS)] : [pick(LIMBS)];
        const dir: Dir = Math.random() < (i === 0 ? 0.55 : 0.35) ? pick(DIRS) : 'n';
        this.steps.push({ dir, limbs });
      }
      this.command = this.steps
        .map(s => (s.dir === 'n' ? '' : `${s.dir}+`) + s.limbs.join('+'))
        .join(',');
    } while (this.command === prev);
    this.idx = 0;
    this.feedback = null;
  }

  private tokens(steps: Step[]): DisplayToken[] {
    return steps.map(s => ({
      kind: 'btn' as const,
      limbs: s.limbs,
      dir: s.dir === 'n' ? null : s.dir,
      holdDir: false,
      justFrame: false,
      tight: false,
    }));
  }

  publish() {
    const msg: NotationStateMsg = {
      command: this.command,
      stepCount: this.steps.length,
      stepIndex: this.idx,
      feedback: this.feedback,
      streak: this.streak,
      hits: this.hits,
      total: this.total,
      difficulty: this.difficulty,
    };
    this.emit('state', msg);
  }
}
