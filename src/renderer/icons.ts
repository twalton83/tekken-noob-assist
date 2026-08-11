// Shared rendering of notation tokens (arrows, labeled Xbox buttons) used by
// both the overlay and the move browser.

import type { Dir, DisplayToken } from '../shared/types.js';

export const DIR_GLYPH: Record<Dir, string> = {
  n: 'N', u: '↑', d: '↓', f: '→', b: '←', uf: '↗', ub: '↖', df: '↘', db: '↙',
};

export const LIMB_BTN: Record<number, { label: string; cls: string }> = {
  1: { label: 'X', cls: 'btn-x' },
  2: { label: 'Y', cls: 'btn-y' },
  3: { label: 'A', cls: 'btn-a' },
  4: { label: 'B', cls: 'btn-b' },
};

export function renderTokens(tokens: DisplayToken[]): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'tokens';
  for (const t of tokens) {
    if (t.kind === 'state') {
      const el = document.createElement('span');
      el.className = 'tok-state';
      el.textContent = t.label;
      wrap.appendChild(el);
    } else if (t.kind === 'dir') {
      const el = document.createElement('span');
      el.className = 'tok-dir' + (t.hold ? ' hold' : '');
      el.textContent = DIR_GLYPH[t.dir];
      wrap.appendChild(el);
    } else {
      if (t.tight) {
        const tld = document.createElement('span');
        tld.className = 'tok-tight';
        tld.textContent = '~';
        wrap.appendChild(tld);
      }
      if (t.dir) {
        const d = document.createElement('span');
        d.className = 'tok-dir' + (t.holdDir ? ' hold' : '');
        d.textContent = DIR_GLYPH[t.dir];
        wrap.appendChild(d);
      }
      if (t.justFrame) {
        const jf = document.createElement('span');
        jf.className = 'tok-jf';
        jf.textContent = ':';
        wrap.appendChild(jf);
      }
      const btns = document.createElement('span');
      btns.className = 'tok-btns';
      for (const limb of t.limbs) {
        const b = LIMB_BTN[limb];
        const ic = document.createElement('span');
        ic.className = `btn-ic ${b.cls}`;
        ic.textContent = b.label;
        btns.appendChild(ic);
      }
      wrap.appendChild(btns);
    }
  }
  return wrap;
}
