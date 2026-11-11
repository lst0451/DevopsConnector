import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('work', { recursive: true });
await mkdir('dist', { recursive: true });
const notices = await Promise.all(['turndown', 'turndown-plugin-gfm', '@mixmark-io/domino'].map(async (name) =>
  name + '\n\n' + await readFile('node_modules/' + name + '/LICENSE', 'utf8')));
await writeFile('dist/THIRD-PARTY-NOTICES.txt', notices.join('\n\n--------------------\n\n'));
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: !process.argv.includes('--production'),
  minify: process.argv.includes('--production'),
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
