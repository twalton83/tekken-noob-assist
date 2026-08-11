// Dev runner: initial build, then TypeScript watchers + Electron with renderer
// hot reload (--dev). Renderer changes (CSS/HTML/TS) reload the open windows
// live; main-process changes need a restart of this script.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const opts = { cwd: root, stdio: 'inherit', shell: true };

for (const p of ['tsconfig.main.json', 'tsconfig.renderer.json']) {
  const r = spawnSync(`npx tsc -p ${p}`, opts);
  if (r.status) process.exit(r.status);
}

const watchers = ['tsconfig.main.json', 'tsconfig.renderer.json'].map(p =>
  spawn(`npx tsc -w --preserveWatchOutput -p ${p}`, opts));

const el = spawn('npx electron . --dev', opts);
el.on('exit', code => {
  for (const w of watchers) {
    if (process.platform === 'win32') {
      spawnSync(`taskkill /pid ${w.pid} /T /F`, { ...opts, stdio: 'ignore' });
    } else {
      w.kill();
    }
  }
  process.exit(code ?? 0);
});
