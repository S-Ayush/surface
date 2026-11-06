import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// Development only (`pnpm dev`, scripts/dev.mjs): the browser talks to Vite, which
// forwards server routes (SERVER_PREFIXES in apps/server/src/http/static.ts) to the
// server. The Host header is kept, so the server sees the SURFACE_URL origin.
const toServer = { target: process.env.SURFACE_DEV_SERVER_URL ?? 'http://localhost:3000' };

export default defineConfig({
  plugins: [react()],
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
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
