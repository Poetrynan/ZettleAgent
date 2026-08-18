/**
 * Lazy gateway to Mermaid.
 *
 * ## Why this file exists
 *
 * `mermaid` is ~1.3 MB of parsed JavaScript, and it was reached by a top-level
 * `import mermaid from 'mermaid'` in both `MarkdownRenderer.tsx` and
 * `MilkdownEditor.tsx`. Because both are on the startup path, every launch paid
 * to parse and execute the whole diagram engine — including the vaults that
 * contain no diagrams at all, which is most of them. This app loads its assets
 * from local disk, so the cost that matters is not transfer but the parse and
 * execute time in front of the first interaction.
 *
 * Importing it on first use moves that work to the moment a ```mermaid fence is
 * actually rendered, and lets Rollup keep the engine in its own chunk.
 *
 * ## Why one shared module rather than two dynamic imports
 *
 * `initialize()` is global and must run exactly once before the first render.
 * With the import inlined at two call sites, that ordering was maintained by
 * both files happening to call `initialize` at module scope with the same
 * options — a duplicated invariant. Here the promise is the singleton, so the
 * second caller awaits the first caller's initialisation instead of repeating
 * it, and `securityLevel` is configured in exactly one place.
 */

/** Matches the theme detection the rest of the app uses. */
function isDarkMode(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark' ||
         document.body.classList.contains('dark-theme') ||
         window.matchMedia('(prefers-color-scheme: dark)').matches;
}

type MermaidModule = typeof import('mermaid')['default'];

let loading: Promise<MermaidModule> | null = null;

/** Import and initialise Mermaid once; later callers reuse the same promise. */
function loadMermaid(): Promise<MermaidModule> {
  if (!loading) {
    loading = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: isDarkMode() ? 'dark' : 'default',
        // Notes are untrusted input (synced, shared, Agent- or clipper-written),
        // so 'loose' would let a diagram label inject executable markup into the
        // webview. 'strict' escapes HTML in node labels and disables
        // `click ... call`.
        securityLevel: 'strict',
      });
      return mermaid;
    });
  }
  return loading;
}

/**
 * Render one diagram to SVG markup.
 *
 * Rejects the way `mermaid.render` does, so existing error handling — the syntax
 * error boxes in the renderer and the editor — keeps working unchanged.
 */
export async function renderMermaid(id: string, content: string): Promise<string> {
  const mermaid = await loadMermaid();
  const { svg } = await mermaid.render(id, content);
  return svg;
}
