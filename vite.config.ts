/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import preact from '@preact/preset-vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The mist engine normally comes from npm (@tik-choco/mistlib). Point
  // MISTLIB_LOCAL at a local `wasm-pack build` output (mistlib-dev's
  // mistlib-wasm/pkg) in .env to run against an engine you're editing.
  //
  // An alias rather than an npm install so switching leaves package.json and
  // the lockfile untouched — there's nothing to remember to revert. The
  // trade-off: this only redirects Vite (dev, build, and vitest, which reads
  // this same config). `tsc` keeps reading types from node_modules, so if the
  // engine's API itself changed, install the local build instead:
  //   npm i "@tik-choco/mistlib@file:../mistlib-dev/mistlib-wasm/pkg"
  //
  // '' as the prefix: loadEnv only exposes VITE_-prefixed keys by default, and
  // MISTLIB_LOCAL is build-time config that must never reach client code.
  const localEngine = loadEnv(mode, process.cwd(), '').MISTLIB_LOCAL
  const alias: Record<string, string> = {}
  if (localEngine) {
    alias['@tik-choco/mistlib'] = path.resolve(process.cwd(), localEngine)
    console.log(`vite: using local mist engine at ${alias['@tik-choco/mistlib']}`)
  }

  return {
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [preact()],
  resolve: { alias },
  test: {
    // Vitest's default excludes don't cover dotfolders like .claude/ — without
    // this, `npm test` from the repo root also picks up and re-runs every
    // test file inside any git worktree checked out under .claude/worktrees/
    // (e.g. background agents working in parallel), which is slow and makes
    // failures there look like failures here.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/.git/**'],
  },
  }
})
