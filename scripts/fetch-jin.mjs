// Fetch Jin's complete Tekken 8 move list from the Wavu wiki Cargo API
// and write it to data/jin.json. Run: npm run fetch-data
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
      .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
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
  const url = `${API}?action=cargoquery&format=json&tables=Move&fields=${FIELDS}` +
    `&where=id%20LIKE%20%27Jin-%25%27&limit=500&offset=${offset}`;
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

const byId = new Map(all.map(m => [m.id, m]));

const normalizeId = id => id.replace(/\$\{justFrame\}/g, ':');

const moves = all.map(m => {
  // Full command lives in the id ("Jin-f,n,d,df:2" -> "f,n,d,df:2").
  // The `input` field only holds the continuation for child string moves.
  m.id = normalizeId(m.id);
  if (m.parent) m.parent = normalizeId(m.parent);
  const command = m.id.replace(/^Jin-/, '');
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
writeFileSync(join(ROOT, 'data', 'jin.json'), JSON.stringify({
  character: 'Jin',
  game: 'Tekken 8',
  source: 'https://wavu.wiki (Cargo Move table)',
  fetchedAt: new Date().toISOString(),
  moves,
}, null, 2));
console.log(`wrote data/jin.json with ${moves.length} moves`);
