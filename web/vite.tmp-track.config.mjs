import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({ plugins: [react()], build: { outDir: '../.tmp-test/dist-track', emptyOutDir: true, rollupOptions: { input: { track: resolve(import.meta.dirname, 'track.html') } }, chunkSizeWarningLimit: 1500 } });
