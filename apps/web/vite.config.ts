import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { appCache } from './vite-app-cache.js';
import { brandManifest } from './vite-brand.js';

// Development only (`pnpm dev`, scripts/dev.mjs): the browser talks to Vite, which
// forwards server routes (SERVER_PREFIXES in @surface/sync-protocol/server-paths) to the
// server. The Host header is kept, so the server sees the SURFACE_URL origin.
const toServer = { target: process.env.SURFACE_DEV_SERVER_URL ?? 'http://localhost:3000' };

export default defineConfig({
  // ADR-0019: `vite build` also writes `dist/sw.js`, the offline app cache's worker.
  plugins: [react(), brandManifest(), appCache()],
  resolve: {
    // Consume workspace packages from TypeScript source (see packages/config/tsconfig.base.json).
    conditions: ['@surface/source', ...defaultClientConditions],
  },
  server: {
    port: Number(process.env.SURFACE_DEV_WEB_PORT ?? 5173),
    // SURFACE_URL names this port: fail rather than silently move to another one.
    strictPort: true,
    // Whole path segments only, like the server: /api/x is proxied, /apikeys is not.
    // Vite matches against the URL including its query string.
    proxy: {
      '^/(api|auth|files)/': toServer,
      '^/sync/': { ...toServer, ws: true },
      '^/mcp([/?]|$)': toServer,
      '^/(healthz|readyz|metrics)([?]|$)': toServer,
      // `/setup` is both the wizard page (served here) and its endpoint (POST, the server's), so
      // only the status endpoint and the POST go through (PLAN-001 S2).
      '^/setup(/status)?([?]|$)': {
        ...toServer,
        bypass: (req) =>
          req.method === 'GET' && !req.url?.startsWith('/setup/status') ? req.url : undefined,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The brand icons are small, but must stay files under assets/ (not data: URLs in the page):
    // the manifest points at them, and the offline cache keeps assets/ (PLAN-017 S1).
    assetsInlineLimit: (file) => (file.includes('/src/brand/') ? false : undefined),
  },
});
