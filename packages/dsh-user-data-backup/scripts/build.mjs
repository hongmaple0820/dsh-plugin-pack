/** Bundle owned entrypoints and audited protocol libraries; host services and React remain externals. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { writeBundledNotices } from './notices.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: ['src/client.js'], outfile: 'lib/client.js', bundle: true,
  loader: { '.css': 'text' },
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "@local/dsh-user-data-backup", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
  legalComments: 'eof' })
const host = await build({ absWorkingDir: root, entryPoints: ['src/host.js'], outfile: 'lib/host.js', bundle: true, metafile: true,
  format: 'esm', platform: 'node', target: 'node22', external: ['@deepseek-ai/*'],
  banner: { js: "import { createRequire as __hostCreateRequire } from 'node:module'; const require = __hostCreateRequire(import.meta.url);" },
  legalComments: 'eof' })
await writeBundledNotices(root, host.metafile)
console.log('Built independent data management host and client')
