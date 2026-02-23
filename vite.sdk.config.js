import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './sdk.js',
      name: 'GhostClip',
      fileName: (format) => `ghostclip-sdk.${format}.js`,
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['@imgly/background-removal'],
      output: {
        globals: {
          '@imgly/background-removal': 'imglyBackgroundRemoval',
        },
      },
    },
    outDir: 'dist-sdk',
    emptyOutDir: true,
  },
});
