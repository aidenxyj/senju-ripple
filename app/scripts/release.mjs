// npm run release: build the Mac installers and say how to publish them.
// The installers are too large for the website's host, so they are published as a GitHub Release.
// The download page links to .../releases/latest/download/Senju-arm64.dmg and Senju-x64.dmg.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const SITE_REPO = process.env.SENJU_RELEASE_REPO ?? 'JamesGongYC/senju-site';

if (process.platform !== 'darwin') { console.error('Mac installers can only be built on a Mac.'); process.exit(1); }
execFileSync('npx', ['electron-builder', '--mac'], { cwd: ROOT, stdio: 'inherit' });

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dmgs = fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => f.endsWith('.dmg')).map((f) => path.join('dist', f));
console.log(`\nBuilt ${dmgs.join(', ')}.\n\nPublish them (the repository must be public for the links to work):\n`);
console.log(`  gh release create v${version} ${dmgs.join(' ')} --repo ${SITE_REPO} --title "Senju ${version}" --notes "Senju ${version} for macOS."\n`);
