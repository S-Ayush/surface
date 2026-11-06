import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume workspace packages from TypeScript source (see packages/config/tsconfig.base.json).
    conditions: ['@surface/source', ...defaultClientConditions],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
