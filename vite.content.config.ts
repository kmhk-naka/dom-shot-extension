import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/content.ts',
      formats: ['iife'],
      name: 'DomShotContent',
      fileName: () => 'content.js'
    }
  }
});
