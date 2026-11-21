import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';

// Same as @ardudeck/module-sdk/esbuild (MIT): point react imports at the host's React instance,
// so hooks work. Inlined because Node can't load the SDK's .ts file from node_modules.
const HOST_GLOBAL_MAP = {
  'react': 'window.__ardudeckHost.react',
  'react-dom': 'window.__ardudeckHost.reactDom',
  'react-dom/client': 'window.__ardudeckHost.reactDom',
};
const ardudeckModulePlugin = () => ({
  name: 'ardudeck-module-host-externals',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|react-dom\/client)$/ }, (args) => ({ path: args.path, namespace: 'ardudeck-host-ext' }));
    b.onLoad({ filter: /.*/, namespace: 'ardudeck-host-ext' }, (args) => ({
      contents: `module.exports = ${HOST_GLOBAL_MAP[args.path]};`,
      loader: 'js',
    }));
  },
});

await mkdir('dist', { recursive: true });

// Tell Node the bundled main.js is ESM (no surrounding package.json otherwise).
await writeFile('dist/package.json', JSON.stringify({ type: 'module' }, null, 2));

await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['electron', 'node-pty'],
  outfile: 'dist/main.js',
});

await build({
  entryPoints: ['src/renderer/index.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  plugins: [ardudeckModulePlugin()],
  outfile: 'dist/renderer.js',
});

await copyFile('module.json', 'dist/module.json');
console.log('Build complete.');
