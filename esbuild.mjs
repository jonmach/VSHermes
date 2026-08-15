/**
 * VSHermes build script.
 * - Extension host bundle  -> dist/extension.js (CJS, vscode external)
 * - Webview frontend       -> dist/media/chat.js (IIFE, browser)
 */
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: true,
  target: 'es2022',
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...shared,
  entryPoints: ['src/views/media/chat.ts'],
  outfile: 'dist/media/chat.js',
  platform: 'browser',
  format: 'iife',
};

/** @type {import('esbuild').BuildOptions} */
const endpoints = {
  ...shared,
  entryPoints: ['src/views/media/endpoints.ts'],
  outfile: 'dist/media/endpoints.js',
  platform: 'browser',
  format: 'iife',
};

const ctxExt = await esbuild.context(extension);
const ctxWeb = await esbuild.context(webview);
const ctxEnd = await esbuild.context(endpoints);

if (watch) {
  await Promise.all([ctxExt.watch(), ctxWeb.watch(), ctxEnd.watch()]);
  console.log('[vsh-hermes] watching…');
} else {
  await Promise.all([ctxExt.rebuild(), ctxWeb.rebuild(), ctxEnd.rebuild()]);
  await Promise.all([ctxExt.dispose(), ctxWeb.dispose(), ctxEnd.dispose()]);
  console.log('[vsh-hermes] build complete');
}
