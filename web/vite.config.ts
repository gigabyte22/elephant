import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite dev serves the SPA on :5173 and proxies the dashboard API + the
// embedding service's other routes back to Fastify on :18790. In production
// the static build at /dashboard is served by @fastify/static — no proxy.

const BACKEND = process.env.ELEPHANT_API_URL ?? 'http://127.0.0.1:18790';

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/dashboard/api': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
    },
  },
});
