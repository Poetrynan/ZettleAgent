import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { katexInlinedPath } from "./src/lib/katex-resolve";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@katex-inlined-css": katexInlinedPath,
    },
  },

  // Use relative paths so Tauri's custom protocol can resolve assets correctly
  base: './',

  build: {
    rollupOptions: {
      output: {
        /**
         * Split stable third-party code out of the app chunk.
         *
         * To be clear about what this does and does not buy: for a library that
         * the entry still imports statically, moving it to its own chunk does
         * *not* reduce startup work — the same bytes are parsed either way. What
         * it buys is that editing app code no longer rewrites a single 6 MB
         * file, which keeps the webview's compiled-code cache warm across
         * updates and makes the build output readable enough to spot regressions
         * in. The startup win comes from the `React.lazy` boundaries in
         * `App.tsx` and the deferred Mermaid import, not from this.
         *
         * Deliberately *not* grouped: `mermaid`, `cytoscape`, and CodeMirror's
         * language packages. Each of those is reached through a dynamic import
         * — one chunk per diagram type, one per syntax mode — and naming them
         * here collapses the whole set into a single eager blob, which is the
         * opposite of what we want. Grouping `@codemirror/*` wholesale did
         * exactly that in an earlier revision: ~150 lazy language-mode chunks
         * became one 1.7 MB chunk loaded up front. Hence the narrow allow-list
         * of core runtime packages below.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          const path = id.replace(/\\/g, '/');
          if (/node_modules\/(react|react-dom|scheduler)\//.test(path)) return 'vendor-react';
          if (path.includes('node_modules/three/')) return 'vendor-three';
          if (path.includes('node_modules/pixi.js/')) return 'vendor-pixi';
          if (path.includes('node_modules/@xyflow/')) return 'vendor-xyflow';
          // Core editor runtime only — `language-data`, `legacy-modes` and the
          // `lang-*` / `@lezer/<grammar>` packages stay on their own lazy chunks.
          if (/node_modules\/@codemirror\/(view|state|language|autocomplete|commands|search|lint)\//.test(path)) return 'vendor-codemirror';
          if (/node_modules\/@lezer\/(common|highlight|lr)\//.test(path)) return 'vendor-codemirror';
          if (/node_modules\/(@milkdown|prosemirror-)/.test(path)) return 'vendor-milkdown';
          if (/node_modules\/(katex|rehype-katex)\//.test(path)) return 'vendor-katex';
          if (path.includes('node_modules/highlight.js/')) return 'vendor-highlight';
          return;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
