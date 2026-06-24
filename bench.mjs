#!/usr/bin/env node
// Bundles and runs the index load benchmark (src/bench.ts).
import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const outfile = path.join(tmpdir(), `breadcrumbs-bench-${process.pid}.mjs`)
await build({
  entryPoints: ['src/bench.ts'],
  bundle: true,
  outfile,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
})
try {
  await import(`file://${outfile}`)
} finally {
  await rm(outfile, { force: true })
}
