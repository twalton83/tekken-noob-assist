// Move browser: compact, searchable version of the in-game move list.
// Click a move to make it the active training drill.

import { renderTokens } from './icons.js';
import type { MoveListEntry } from '../shared/types.js';

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

let moves: MoveListEntry[] = [];
let selectedId: string | null = null;

// loose matching: "df2" finds "df+2", "electric"/"hopkick" find by name
const normalize = (s: string) => s.toLowerCase().replace(/[+.,:~\s]/g, '');

function matches(m: MoveListEntry, q: string): boolean {
  if (!q) return true;
  const nq = normalize(q);
  return normalize(m.command).includes(nq) || normalize(m.name ?? '').includes(nq);
}

function frameCls(v: string | null): string {
  if (!v) return '';
  return v.trim().startsWith('-') ? 'neg' : 'pos';
}

function render() {
  const q = ($('search') as HTMLInputElement).value;
  const list = $('list');
  list.textContent = '';
  let shown = 0;
  for (const m of moves) {
    if (!matches(m, q)) continue;
    shown++;
    const row = document.createElement('div');
    row.className = 'row' + (m.recognizable ? '' : ' disabled') + (m.id === selectedId ? ' selected' : '');
    row.dataset.id = m.id;

    row.appendChild(renderTokens(m.tokens));

    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    cmd.textContent = m.command;
    row.appendChild(cmd);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name ?? '';
    row.appendChild(name);

    const frames = document.createElement('span');
    frames.className = 'frames';
    const bits: string[] = [];
    if (m.startup) bits.push(m.startup.split(' ')[0]);
    if (m.damage) bits.push(`${m.damage}dmg`);
    frames.textContent = bits.join(' · ');
    if (m.onBlock) {
      const ob = document.createElement('span');
      ob.className = frameCls(m.onBlock);
      ob.textContent = ` ${m.onBlock.split(' ')[0]}b`;
      frames.appendChild(ob);
    }
    row.appendChild(frames);

    if (m.recognizable) {
      row.addEventListener('click', () => {
        window.trainerApi.send('select-move', m.id);
      });
    } else {
      row.title = m.reason ?? 'not recognizable from input';
    }
    list.appendChild(row);
  }
  $('count').textContent = `${shown}/${moves.length}`;
}

window.trainerApi.on('moves', p => {
  const { character, entries } = p as { character: string; entries: MoveListEntry[] };
  $('char-label').textContent = `${character} · command list`;
  moves = entries;
  selectedId = null; // a selected drill doesn't survive a character switch
  render();
});

window.trainerApi.on('selected', p => {
  selectedId = (p as { id: string }).id;
  render();
});

$('search').addEventListener('input', () => render());
$('close-btn').addEventListener('click', () => window.trainerApi.send('moves-hide'));
$('settings-btn').addEventListener('click', () => window.trainerApi.send('open-settings'));
window.trainerApi.send('moves-ready');
