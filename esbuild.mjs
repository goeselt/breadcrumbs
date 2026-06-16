#!/usr/bin/env node

import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** @type {import('esbuild').Plugin} */
const inlineTextPlugin = {
  name: 'inline-text',
  setup(buildApi) {
    buildApi.onResolve({ filter: /\?inline$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, '')),
      namespace: 'inline-text',
    }))
    buildApi.onLoad({ filter: /.*/, namespace: 'inline-text' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: true,
  plugins: [inlineTextPlugin],
}

await build(opts)
