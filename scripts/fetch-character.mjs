// Fetch a character's complete Tekken 8 move list from the Wavu wiki Cargo API
// and write it to data/<character>.json.
// Run: npm run fetch-data            (defaults to Jin)
//      npm run fetch-data Yoshimitsu
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHARACTER = process.argv[2] || 'Jin';
const OUTFILE = CHARACTER.toLowerCase().replace(/\s+/g, '-') + '.json';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://wavu.wiki/w/api.php';
const FIELDS = 'id,name,input,parent,target,damage,startup,recv,block,hit,ch,crush,notes';

function decodeEntities(s) {
  if (!s) return s;
  let prev;
  do { // entities are often double-encoded (&amp;gt;)
    prev = s;
    s = s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  } while (s !== prev);
  return s;
}

function stripHtml(s) {
  if (!s) return s;
  return decodeEntities(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Some moves have several names wrapped in an HTML bullet list — join them.
function cleanName(s) {
  if (!s) return s;
  s = decodeEntities(s);
  if (!s.includes('<')) return s;
  const items = s.replace(/<[^>]*>/g, '\n')
    .split('\n')
    .map(l => l.replace(/^\s*\*\s*/, '').trim())
    .filter(Boolean);
  return items.join(' / ');
}

async function fetchPage(offset) {
  const where = encodeURIComponent(`id LIKE '${CHARACTER}-%'`);
  const url = `${API}?action=cargoquery&format=json&tables=Move&fields=${FIELDS}` +
    `&where=${where}&limit=500&offset=${offset}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tekken-trainer/0.1 (personal training tool)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.cargoquery ?? []).map(e => e.title);
}

const all = [];
for (let offset = 0; ; offset += 500) {
  const page = await fetchPage(offset);
  all.push(...page);
  console.log(`fetched ${page.length} moves (offset ${offset})`);
  if (page.length < 500) break;
}

if (all.length === 0) {
  console.error(`no moves found for "${CHARACTER}" — check the character name (as used in wavu.wiki move ids)`);
  process.exit(1);
}

const byId = new Map(all.map(m => [m.id, m]));

// ids can carry template placeholders and (double-encoded) HTML entities.
// ${justFrame} is wavu's placeholder for '#', their just-frame marker — it can
// even appear inside an entity ("f,F+2&amp;${justFrame}58;2" = "f,F+2:2").
// Restore '#', decode entities, then map '#' to ':' (our just-frame notation).
const normalizeId = id => decodeEntities(id.replace(/\$\{justFrame\}/g, '#')).replace(/#/g, ':');

const prefix = new RegExp('^' + CHARACTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-');

const moves = all.map(m => {
  // Full command lives in the id ("Jin-f,n,d,df:2" -> "f,n,d,df:2").
  // The `input` field only holds the continuation for child string moves.
  m.id = normalizeId(m.id);
  if (m.parent) m.parent = normalizeId(m.parent);
  const command = m.id.replace(prefix, '');
  return {
    id: m.id,
    name: cleanName(m.name) || null,
    command,
    input: m.input,
    parent: m.parent || null,
    target: m.target || null,
    damage: m.damage || null,
    startup: m.startup || null,
    recovery: m.recv || null,
    onBlock: m.block || null,
    onHit: m.hit || null,
    onCH: m.ch || null,
    crush: m.crush || null,
    notes: stripHtml(m.notes) || null,
  };
});

// sanity: every parent referenced should exist
const missingParents = moves.filter(m => m.parent && !byId.has(m.parent)).map(m => m.id);
if (missingParents.length) console.warn('moves with missing parents:', missingParents);

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', OUTFILE), JSON.stringify({
  character: CHARACTER,
  game: 'Tekken 8',
  source: 'https://wavu.wiki (Cargo Move table)',
  fetchedAt: new Date().toISOString(),
  moves,
}, null, 2));
console.log(`wrote data/${OUTFILE} with ${moves.length} moves`);
