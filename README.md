# sparcd-exploration

A workspace for building small, focused, mostly-static tools that work
alongside [SPARC'd](https://github.com/CulverLab/sparcd-web) — each one
tuned end-to-end for a single feature.

A shared landing page ties them together at the deploy root. The uploader
and tagger share a connection gate and a saved-login session, so you
authenticate once and move between them; the explorer has its own sign-in.

## The tools

- **`apps/sparcd-explorer`** — a [marimo](https://marimo.io) notebook that
  signs in to the SPARC'd MinIO backend, loads a collection's Camtrap-DP
  CSVs, and renders a Field Notebook view: a hex-binned map, a species
  dashboard, stat cards, and drill-in tabs for images, detections, and
  locations. Query filters apply on Search; display options tune presentation
  live. Exports to a static Pyodide bundle that runs entirely in the browser
  (see [Static deploy](#static-deploy)).
- **`apps/sparcd-uploader`** — a static, browser-based tool for preparing and
  uploading camera-trap image batches. Drop a folder; it scans JPEGs and MP4
  videos, runs EXIF, SHA-256, and thumbnails in Web Workers, validates the
  batch, then writes the canonical Camtrap-DP layout through the `s3-safe`
  boundary. Dry-run by default.
- **`apps/sparcd-tagger`** — a static, browser-based tagging interface for
  camera-trap images. It reads the same buckets, renders an upload's images
  from presigned URLs, and writes back the canonical Camtrap-DP metadata the
  other readers already consume.
- **`apps/sparcd-home`** — the shared landing page and app switcher served at
  the deploy root.
- **`apps/sparcd-shard-proxy`** — a reverse proxy that presents one S3
  endpoint as several origins, so a browser can upload over several
  connections instead of the single one it coalesces onto per origin. It also
  supplies the CORS that Ceph RGW has no service-level answer for. A Caddyfile,
  a compose file, and a smoke test; recipes for a VM and for a Cloudflare
  Worker.

Each app's `README.md` (and `plan.md` where present) carries its full
design and phase breakdown.

## Approach

- **Alongside SPARC'd.** SPARC'd is the system of record; the tools here
  read from it and add focused views on top.
- **One tool, one job.** Each app in `apps/` solves a single concrete user
  problem (a specific report, a specific view, a specific export). When a new
  need shows up, we add a new app.
- **Static where possible.** Prefer designs that can ship as a static bundle
  (Pyodide / WASM, prebuilt data files, signed S3 URLs). Each tool stays
  cheap to host, easy to share, and free of server-side state.
- **Bring your own S3.** The browser tools have no backend and no server-side
  secret. Users supply an S3-compatible endpoint and credentials; IAM/provider
  policy and bucket CORS are the real access gates. Writes go through
  `@sparcd/s3-safe`, an append-only boundary with no delete or copy API and
  a single reviewed, ETag-gated conditional-replace path
  (`replaceIfUnchanged`).
- **Optimize per feature.** With a narrow scope per app, we pick the best
  primitives for that job — data model, layout, interactions — without
  compromise for anything else.

## Layout

```
apps/
  sparcd-home/       # shared landing page + app switcher (static HTML)
  sparcd-explorer/   # marimo notebooks for data exploration (Python, uv)
  sparcd-uploader/   # batch prep + upload, BYO-S3 (TS, Vite)
  sparcd-tagger/     # tagging interface, BYO-S3 (TS, Vite)
  sparcd-shard-proxy/# multi-origin S3 proxy + CORS (Caddy, compose, smoke test)
packages/
  auth-ui/           # shared connection gate + saved-login session
  camtrap/           # Camtrap-DP data contract (readers, merge, time-shift)
  s3-safe/           # S3 client boundary (append-only + reviewed replace)
  types/             # shared TypeScript types
```

## Toolchain

- **Node** ≥ 20 + **pnpm** 10 — workspace + task runner
- **Turborepo** — pipeline orchestration across apps/packages
- **uv** — Python env/deps for any Python-based app (e.g. marimo)

## Quick start

```sh
pnpm install                                  # installs turbo and JS workspaces

pnpm --filter sparcd-uploader dev             # Vite dev server (uploader)  :5311
pnpm --filter sparcd-tagger dev               # Vite dev server (tagger)    :5312

pnpm --filter @sparcd/sparcd-explorer install:py   # uv sync for the marimo app
pnpm dev --filter @sparcd/sparcd-explorer     # marimo edit --watch
```

Or run every app's `dev` task at once:

```sh
pnpm dev
```

**Testing features that cross the uploader–tagger boundary** (shared IndexedDB,
flip hand-off, etc.) requires both tools on the same browser origin. The
`sparcd-dev-proxy` app starts a Vite proxy on port 5310 that routes both paths
to their own Vite servers. `pnpm dev` starts it automatically alongside the
other apps — navigate to either tool through the proxy port:

```
http://localhost:5310/sparcd-exploration/uploader/
http://localhost:5310/sparcd-exploration/tagger/
```

Hot-module reload works through the proxy because both routes explicitly
forward WebSocket upgrade requests to their Vite server.

The Vite apps prefill the S3 endpoint from a gitignored
`apps/<name>/.env` (`VITE_SPARCD_S3_ENDPOINT`). Credentials are never
prefilled — they are entered at runtime.

## Adding a new app

1. `mkdir apps/<name>`
2. Add a `package.json` with `name`, `private: true`, and at least `dev` /
   `build` scripts. Python apps wrap `uv run …` in their npm scripts.
3. `pnpm install` to pick it up via the workspace.
4. Tasks defined in [`turbo.json`](./turbo.json) (`dev`, `build`, `lint`,
   `start`, `check`, `test`) will run across whichever apps implement them.

## Static deploy

`.github/workflows/pages.yml` builds the landing page and each web tool and
publishes them via GitHub Pages on every push that touches an app, a shared
package, or the workflow itself. The
landing page sits at the root, with each tool under its own path
(`/explorer`, `/uploader`, `/tagger`). Live at:

<https://culverlab.github.io/sparcd-exploration/>

The deployed pages run entirely in the visitor's browser — the explorer runs
Python via Pyodide, and the Vite tools talk to S3 directly. SPARC'd
credentials are entered in the connection gate; there is no server-side
secret. The S3/MinIO endpoint must permit CORS from the Pages origin for data
fetches and uploads to succeed.

## Docs

- Each app's `README.md` (and `plan.md` where present) — that tool's design,
  data contracts, and status
- [`docs/design-system-field-notebook.md`](./docs/design-system-field-notebook.md)
  — the shared visual design system
- [`docs/archive/`](./docs/archive/) — superseded proposals and point-in-time
  reports, kept as decision history; nothing there describes the current
  system
