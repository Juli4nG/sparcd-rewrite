import { defineConfig } from 'vite';

const DEFAULT_TARGETS = {
  uploader: process.env.SPARCD_UPLOADER_DEV_URL ?? 'http://localhost:5311',
  tagger: process.env.SPARCD_TAGGER_DEV_URL ?? 'http://localhost:5312',
};

/**
 * Build the proxy config. The target override lets the smoke test use
 * ephemeral backend ports instead of competing with a developer's servers.
 */
export function createProxyConfig({ targets = DEFAULT_TARGETS, port = 5310 } = {}) {
  return defineConfig({
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    server: {
      port,
      strictPort: true,
      proxy: {
        '/sparcd-exploration/uploader': {
          target: targets.uploader,
          ws: true,
          changeOrigin: true,
        },
        '/sparcd-exploration/tagger': {
          target: targets.tagger,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  });
}

// Single dev entry point that puts both Vite tools on one origin so they can
// share IndexedDB, localStorage, and sessionStorage. Both backend servers must
// already be running (or run `pnpm dev` from the repository root).
export default createProxyConfig();
