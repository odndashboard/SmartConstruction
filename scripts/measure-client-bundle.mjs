import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// Run after `npm run build`: node scripts/measure-client-bundle.mjs / /login
// Count unique initial framework/route JS files, not every generated chunk.
// Dynamic imports and the legacy-browser polyfill are intentionally excluded.
const buildRoot = new URL('../.next/', import.meta.url);
const build = JSON.parse(readFileSync(new URL('build-manifest.json', buildRoot), 'utf8'));
const routes = process.argv.slice(2);
const result = {};
for (const route of routes.length ? routes : ['/', '/login']) {
  if (!route.startsWith('/') || route.includes('..') || route.includes('\\') || route.includes('\0')) {
    throw new Error(`Use a route path such as / or /login: ${route}`);
  }
  const prefix = route === '/' ? '' : `${route.replace(/^\/+|\/+$/g, '')}/`;
  const source = readFileSync(new URL(`server/app/${prefix}page_client-reference-manifest.js`, buildRoot), 'utf8');
  const match = source.match(/__RSC_MANIFEST\["[^"]+"\]\s*=\s*(\{.*\});\s*$/s);
  if (!match) throw new Error(`Cannot read the client-reference manifest for ${route}.`);
  const manifest = JSON.parse(match[1]);
  const names = new Set(build.rootMainFiles);
  for (const files of Object.values(manifest.entryJSFiles)) for (const name of files) names.add(name.replace(/^\/_next\//, ''));
  const files = [...names].filter(name => name.endsWith('.js')).sort().map(file => {
    const content = readFileSync(new URL(file, buildRoot));
    return { file, bytes: content.length, gzip: gzipSync(content, { level: 9 }).length };
  });
  result[route] = {
    js_files: files,
    js_bytes: files.reduce((total, file) => total + file.bytes, 0),
    js_gzip_bytes: files.reduce((total, file) => total + file.gzip, 0),
  };
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
