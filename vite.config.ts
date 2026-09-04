import { defineConfig } from 'vite';

// base: './' keeps the build portable — the same dist/ works on GitHub Pages
// (user.github.io/repo/), on a plain static host, and opened from disk.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
