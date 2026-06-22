
import fs from 'fs';
import { execFileSync } from 'child_process';
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const zipPath = `release/${pkg.name}-${pkg.version}.zip`;
fs.rmSync('release', { recursive: true, force: true });
fs.mkdirSync('release', { recursive: true });
execFileSync('zip', ['-qr', zipPath, 'package.json', 'README.md', 'assets', 'dist']);
console.log(zipPath);
