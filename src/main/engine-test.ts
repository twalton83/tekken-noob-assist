// Offline engine test: no Electron, no controller. Verifies (1) the notation
// compiler covers the full move lists of all fetched characters, (2) the
// recognizer identifies moves from synthetic input streams. Run: npm run test-engine

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileAll, type CompiledMove, type RawMove } from '../shared/notation';
import { Recognizer, annotateStanceHints } from './recognizer';
import type { Dir, Limb, RecognizedMoveMsg } from '../shared/types';
import type { PadSample } from './xinput';

const ROOT = join(__dirname, '..', '..');
const stanceOverrides = JSON.parse(readFileSync(join(ROOT, 'data', 'stances.json'), 'utf8'));

function loadCompiled(file: string): Map<string, CompiledMove> {
  const data = JSON.parse(readFileSync(join(ROOT, 'data', file), 'utf8'));
  const raws: RawMove[] = data.moves.map((m: Record<string, unknown>) => ({
    id: m.id, name: m.name, command: m.command, parent: m.parent, notes: m.notes,
  }));
  const out = compileAll(raws);
  annotateStanceHints(out, data.moves, stanceOverrides);
  return out;
}

// ---- 1) parser coverage ----
const compiled = loadCompiled('jin.json');
const yoshi = loadCompiled('yoshimitsu.json');
for (const [who, map] of [['Jin', compiled], ['Yoshimitsu', yoshi]] as const) {
  const bad = [...map.values()].filter(m => m.unrecognizable);
  console.log(`parser (${who}): ${map.size - bad.length}/${map.size} moves compiled`);
  for (const m of bad) console.log(`  skipped ${m.id}: ${m.unrecognizable}`);
}

let failures = 0;

// ---- 2) stance-hint derivation ----
function expectHint(map: Map<string, CompiledMove>, id: string, stance: string) {
  const hint = (map.get(id) as (CompiledMove & { stanceHint?: string }) | undefined)?.stanceHint;
  const pass = hint === stance;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  hint ${id} -> ${stance}${pass ? '' : ` (got ${hint})`}`);
}
expectHint(compiled, 'Jin-b+3+4', 'ZEN');        // from recovery "r5 ZEN"
expectHint(compiled, 'Jin-f+3', 'ZEN');          // from stances.json override
expectHint(yoshi, 'Yoshimitsu-1+2', 'KIN');      // from recovery "r15 KIN"
expectHint(yoshi, 'Yoshimitsu-d+3+4', 'IND');    // from recovery "r20 IND"
expectHint(yoshi, 'Yoshimitsu-FLE.3', 'FLE');    // stance move that stays in stance

// ---- 3) synthetic recognition ----
function scenario(name: string, expectIds: string[], run: (feed: (dir: Dir, limbs: Limb[], dtMs: number) => void) => void, moves: Map<string, CompiledMove> = compiled) {
  const rec = new Recognizer(moves);
  const got: RecognizedMoveMsg[] = [];
  rec.on('move', (m: RecognizedMoveMsg) => got.push(m));
  let t = 10_000;
  const feed = (dir: Dir, limbs: Limb[], dtMs: number) => {
    t += dtMs;
    rec.feed({ t, dir, limbs: new Set(limbs), connected: true } as PadSample);
  };
  run(feed);
  // settle: advance time so pending chords flush
  feed('n', [], 100); feed('n', [], 100);

  const gotIds = got.map(m => m.id);
  const pass = expectIds.every((id, i) => gotIds[i] === id) && gotIds.length === expectIds.length;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log(`    expected [${expectIds.join(', ')}]  got [${gotIds.join(', ')}]`);
}

// plain jab
scenario('jab (1)', ['Jin-1'], feed => {
  feed('n', [], 8);
  feed('n', [1], 8);
  feed('n', [], 8);
});

// 1,2 string
scenario('1,2 string', ['Jin-1', 'Jin-1,2'], feed => {
  feed('n', [1], 8);
  feed('n', [], 150);
  feed('n', [2], 8);
  feed('n', [], 8);
});

// 1,2,3 full string
scenario('1,2,3 string', ['Jin-1', 'Jin-1,2', 'Jin-1,2,3'], feed => {
  feed('n', [1], 8);
  feed('n', [], 150);
  feed('n', [2], 8);
  feed('n', [], 180);
  feed('n', [3], 8);
  feed('n', [], 8);
});

// df+2 launcher
scenario('df+2', ['Jin-df+2'], feed => {
  feed('df', [], 60);
  feed('df', [2], 8);
  feed('df', [], 8);
  feed('n', [], 8);
});

// chord: b+1+2
scenario('b+1+2 chord (skewed fingers)', ['Jin-b+1+2'], feed => {
  feed('b', [], 60);
  feed('b', [1], 6);        // 1 lands 6ms before 2 — should merge
  feed('b', [1, 2], 4);
  feed('b', [], 8);
  feed('n', [], 8);
});

// hopkick uf+4
scenario('uf+4', ['Jin-uf+4'], feed => {
  feed('uf', [], 50);
  feed('uf', [4], 8);
  feed('n', [], 8);
});

// EWGF: f,n,d,df with 2 on the SAME poll as df
scenario('EWGF (electric)', ['Jin-CD.df:2'], feed => {
  feed('f', [], 50);
  feed('n', [], 40);
  feed('d', [], 40);
  feed('df', [2], 8);   // just frame!
  feed('df', [], 8);
  feed('n', [], 8);
});

// WGF: same motion but 2 pressed 60ms after entering df -> non-electric version
scenario('WGF (late 2 = not electric)', ['Jin-CD.df+2'], feed => {
  feed('f', [], 50);
  feed('n', [], 40);
  feed('d', [], 40);
  feed('df', [], 8);    // df starts here...
  feed('df', [2], 60);  // ...2 lands 60ms later: too slow for electric
  feed('df', [], 8);
  feed('n', [], 8);
});

// ws1 after crouch release
scenario('ws1', ['Jin-ws1'], feed => {
  feed('d', [], 8);     // crouch starts
  feed('n', [], 400);   // ...held 400ms, then stand up
  feed('n', [1], 30);
  feed('n', [], 8);
});

// b+2,1 string with direction on first hit only
scenario('b+2,1', ['Jin-b+2', 'Jin-b+2,1'], feed => {
  feed('b', [], 60);
  feed('b', [2], 8);
  feed('b', [], 100);
  feed('n', [], 40);
  feed('n', [1], 8);
  feed('n', [], 8);
});

// f,F+2 dash punch (b,f+2 must not match)
scenario('f,F+2', ['Jin-f,F+2'], feed => {
  feed('f', [], 50);
  feed('n', [], 40);
  feed('f', [], 60);
  feed('f', [2], 8);
  feed('f', [], 8);
  feed('n', [], 8);
});

// ZEN stance: f+3 (enters ZEN) then a DELAYED 1 -> ZEN.1 (a fast 1 = f+3,1 string)
scenario('ZEN.1 after f+3 (delayed 1)', ['Jin-f+3', 'Jin-ZEN.1'], feed => {
  feed('f', [], 60);
  feed('f', [3], 8);
  feed('f', [], 100);
  feed('n', [], 300);
  feed('n', [1], 400);  // ~800ms after f+3: stance move, not the string
  feed('n', [], 8);
});

// fast 1 after f+3 -> the f+3,1 string, not ZEN.1
scenario('f+3,1 string (fast 1)', ['Jin-f+3', 'Jin-f+3,1'], feed => {
  feed('f', [], 60);
  feed('f', [3], 8);
  feed('f', [], 100);
  feed('n', [], 100);
  feed('n', [1], 30);   // ~230ms after f+3: string continuation
  feed('n', [], 8);
});

// 4~3 tight kick
scenario('4~3', ['Jin-4', 'Jin-4~3'], feed => {
  feed('n', [4], 8);
  feed('n', [], 40);
  feed('n', [3], 8);
  feed('n', [], 8);
});

// ---- Yoshimitsu scenarios ----

// Flash: 1+4 chord in neutral
scenario('Yoshi 1+4 Flash', ['Yoshimitsu-1+4'], feed => {
  feed('n', [], 8);
  feed('n', [1, 4], 8);
  feed('n', [], 8);
}, yoshi);

// Kincho: 1+2 enters KIN, a delayed 2 is the stance move
scenario('Yoshi KIN.2 after 1+2', ['Yoshimitsu-1+2', 'Yoshimitsu-KIN.2'], feed => {
  feed('n', [1, 2], 8);
  feed('n', [], 300);
  feed('n', [2], 500);   // ~800ms later: stance move
  feed('n', [], 8);
}, yoshi);

// Indian Stance: d+3+4 enters IND, delayed 1+2 goes to Flea from there
scenario('Yoshi IND.1+2 after d+3+4', ['Yoshimitsu-d+3+4', 'Yoshimitsu-IND.1+2'], feed => {
  feed('d', [], 60);
  feed('d', [3, 4], 8);
  feed('d', [], 100);
  feed('n', [], 300);
  feed('n', [1, 2], 500);
  feed('n', [], 8);
}, yoshi);

console.log(failures === 0 ? '\nall scenarios passed' : `\n${failures} scenario(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
