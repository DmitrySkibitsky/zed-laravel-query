// Bundles the language server into one CommonJS file: dist/laravel-query-server.cjs. The release
// workflow attaches it to the GitHub release `v<version>`, which the Zed extension downloads
// (../src/lib.rs). CommonJS (.cjs) runs regardless of the nearest package.json "type".
import * as fs from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/laravel-query-server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Optional native/edge backends of the database drivers, never used by the server.
  external: ['pg-native', 'cloudflare:sockets', 'pg-cloudflare'],
  define: { LARAVEL_QUERY_VERSION: JSON.stringify(version) },
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'eof',
  logLevel: 'info',
});
