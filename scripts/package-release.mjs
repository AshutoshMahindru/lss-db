
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const dir = `release/${pkg.name}-${pkg.version}`;
fs.rmSync('release', { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const item of ['package.json','README.md','assets','dist']) execFileSync('cp', ['-R', item, dir]);
execFileSync('zip', ['-qr', `${pkg.name}-${pkg.version}.zip`, `${pkg.name}-${pkg.version}`], { cwd: 'release' });
console.log(`release/${pkg.name}-${pkg.version}.zip`);
