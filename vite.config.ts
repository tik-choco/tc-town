/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [preact()],
  test: {
    // Vitest's default excludes don't cover dotfolders like .claude/ — without
    // this, `npm test` from the repo root also picks up and re-runs every
    // test file inside any git worktree checked out under .claude/worktrees/
    // (e.g. background agents working in parallel), which is slow and makes
    // failures there look like failures here.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/.git/**'],
  },
})
