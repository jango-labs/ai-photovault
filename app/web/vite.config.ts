import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // changeOrigin:false keeps the browser's Host header, so the API's same-origin check sees what the browser sent (dev only; production has no proxy). The default target is the DEVELOPMENT API (8482, database photovault_dev), never the production one.
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: process.env.PHOTOVAULT_API_TARGET ?? 'http://127.0.0.1:8482', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: true },
});
