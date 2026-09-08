import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Workspace packages are consumed as TypeScript source (no dist/). Aliasing
// them to their src entry lets Vite transpile them as app source.
const pkg = (name: string, entry: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/${entry}`, import.meta.url));

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.features-gen/**'],
  },
  // Served from a subpath on GitHub Pages: culverlab.github.io/sparcd-exploration/tagger/
  base: '/sparcd-exploration/tagger/',
  server: { port: 5312 },
  plugins: [react()],
  resolve: {
    alias: {
      '@sparcd/types': pkg('types', 'index.ts'),
      '@sparcd/s3-safe': pkg('s3-safe', 'index.ts'),
      '@sparcd/auth-ui': pkg('auth-ui', 'index.ts'),
      '@sparcd/camtrap': pkg('camtrap', 'index.ts'),
      '@sparcd/flip': pkg('flip', 'index.ts'),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
