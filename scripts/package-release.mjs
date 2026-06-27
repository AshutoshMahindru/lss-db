
import fs from 'fs';
import { execFileSync } from 'child_process';
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const zipPath = `release/${pkg.name}-${pkg.version}.zip`;
fs.rmSync('release', { recursive: true, force: true });
fs.mkdirSync('release', { recursive: true });
const files = ['package.json', 'assets', 'dist'];
if (fs.existsSync('README.md')) files.splice(1, 0, 'README.md');
execFileSync('zip', ['-qr', zipPath, ...files]);
console.log(zipPath);
