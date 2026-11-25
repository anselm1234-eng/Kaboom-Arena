import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GIT_DIR = resolve(REPO_ROOT, '.git');

/**
 * Short commit hash read straight from .git files: the Docker build stage
 * has no git binary, so `git rev-parse` is not an option there.
 */
function gitCommit(): string {
  try {
    const head = readFileSync(resolve(GIT_DIR, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    try {
      return readFileSync(resolve(GIT_DIR, ref), 'utf8').trim().slice(0, 7);
    } catch {
      const packed = readFileSync(resolve(GIT_DIR, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        if (line.endsWith(` ${ref}`)) return line.slice(0, 7);
      }
    }
  } catch {
    // No .git in the build context; fall through.
  }
  return 'unknown';
}

const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  version?: string;
};

export default defineConfig({
  // 🚨 CHANGE 1: Tell Vite your app will live in a subfolder on GitHub Pages
  base: '/Kaboom-Arena/', 
  
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version ?? '0.0.0'),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      // changeOrigin must stay off: the auth API compares the browser's Origin
      // header against Host for CSRF protection, so the proxy must pass the
      // original Host (localhost:5173) through instead of rewriting it.
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/uploads': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  // 🚨 CHANGE 2: You renamed the package earlier, so this must match!
  optimizeDeps: { exclude: ['@kaboom-arena/shared'] }, 
  build: { target: 'es2022' },
});