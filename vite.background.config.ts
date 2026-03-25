import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/background.ts',
      formats: ['iife'],
      name: 'DomShotBackground',
      fileName: () => 'background.js'
    }
  }
});
