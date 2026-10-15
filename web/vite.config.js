import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Two pages: the admin app (index.html) and the public customer tracking page (track.html).
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), track: resolve(import.meta.dirname, 'track.html') } }, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000', '^/driver/': 'http://localhost:4000' } },
});
