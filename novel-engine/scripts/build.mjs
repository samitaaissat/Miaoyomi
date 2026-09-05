import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
await build({ entryPoints: ['src/guest.mjs'], outfile: 'dist/guest.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2020', minify: true });
for (const dir of ['src', 'scripts']) for (const file of await readdir(dir)) if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', `${dir}/${file}`]);
