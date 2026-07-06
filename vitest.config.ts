import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { katexInlinedPath } from './src/lib/katex-resolve';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@katex-inlined-css': katexInlinedPath,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
