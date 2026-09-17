import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
