# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Zoteus is an MCP server (TypeScript, Node >= 20.19, NodeNext ESM) that exposes a Zotero library to Claude, ChatGPT and other MCP clients as 31 `zotero_*` tools. Published to npm as `@oscardvs/zoteus`; `dist/index.js` is the `zoteus` binary.

## Commands

```bash
npm test                      # vitest run (whole suite; live e2e self-skips without ZOTERO_API_KEY)
npx vitest run tests/tools/get-item.test.ts          # one file
npx vitest run -t "search_items points"              # one test by name
npm run test:watch
npm run typecheck             # tsc --noEmit on src/ only (build project)
npm run typecheck:tests       # tsc -p tsconfig.test.json: src/ + tests/, blocking in CI
npm run lint                  # eslint . --ext .ts
npm run format                # prettier --write .
npm run build                 # tsc -> dist/
npm run dev                   # tsx src/index.ts (stdio transport)
npm run inspector             # MCP Inspector against the source
npm run gen:codex             # regenerate codex/zotero/*.ts wrappers from the tool registry
```

The full CI gate, run before opening a PR: `npm run typecheck && npm run typecheck:tests && npm run lint && npm test`. CI runs it on Node 20 and 22; the Node 20 floor exists because `pdfjs-dist` is pinned to 5.6.205, and `tests/node-floor.test.ts` fails if the pin, lockfile and CI matrix drift apart.

`scripts/check-tools.mjs` drives the built `dist/index.js` over stdio like a real client and prints the tool list; useful after changing tool descriptions or registration.

## House rules (from CONTRIBUTING.md)

- **Relative imports must end in `.js`** even though the source is `.ts` (NodeNext ESM).
- **Test-first.** New behavior lands with a test that fails before the change. Tests live under `tests/` mirroring `src/`; `vitest.config.ts` only picks up `tests/**/*.test.ts`.
- **Tool design:** few consolidated, well-described `zotero_*` tools with structured output, not one-to-one endpoint mirrors.
- **Safety:** writes are versioned and reversible by default (trash over delete); permanent delete stays opt-in and confirmation-gated.
- `tsconfig.json` is the build project (rootDir `src`, tests excluded) and must keep that contract. `tsconfig.test.json` type-checks tests with `noUncheckedIndexedAccess` off, on purpose; src keeps it on.
- Conventional-commit style (`fix:`, `feat:`, `docs:`, `chore(release):`). `CHANGELOG.md` follows Keep a Changelog; add an entry for user-visible changes.

## Architecture

`docs/architecture.md` has the full layer diagram and source map. The parts that take reading several files to see:

**Single tool registry drives everything.** Each `src/tools/*.ts` default-exports a `ToolDefinition` (`src/registry/registry.ts`): `name`, `title`, `description`, zod `inputSchema` (raw shape), zod `outputSchema`, MCP `annotations`, `handler(args, ctx)`. `src/tools/index.ts` lists them in order. From that one list come: MCP registration (`registerAllTools`, which also applies strict/closed argument parsing from `strict-args.ts`), the `search_tools` progressive-disclosure catalog, the read-only mode filter in `src/server.ts` (tools with `readOnlyHint` plus `zotero_index`; mirrored by `tests/read-only.test.ts`), and the generated `codex/zotero/*.ts` code-execution wrappers (`src/codex/generate.ts`). Adding a tool means one file in `src/tools/`, one entry in `src/tools/index.ts`, and `npm run gen:codex`.

**Tool results.** Handlers return via `ok(structured, summary)`: a summary text block, a JSON text mirror of the same data, and `structuredContent`. The mirror exists because some clients ignore `structuredContent`. The MCP SDK validates every non-error `structuredContent` against the tool's `outputSchema`, so `tests/validate-tool-output.ts` (a vitest setup file) wraps every handler and does the same check on every result the suite produces. A field that is not always present must be optional in the output schema. Shared argument definitions (`library_type`/`library_id`, etc.) live in `src/tools/common-args.ts` and `common-output.ts`; a group is addressed by numeric id and `library_type: "group"` alone is refused.

**ToolContext** (same file) is the dependency bag every handler gets: config, capabilities, `router`, `schema`, web/local/localWrites/connectorWrites clients, styles, translation, `search` index, scholar graph, logger, plus `remoteCaller` (confines caller-supplied filesystem paths to the data dir on HTTP/OAuth deployments) and `zoteroUserId` (multi-tenant). `buildServer()` in `src/server.ts` wires it; `createDeferredServer` lets a transport answer `initialize` before the slow context build finishes.

**LibraryRouter** (`src/router/library-router.ts`) decides local-vs-cloud per operation. Reads go to the Zotero desktop local API when it is up, else the Web API v3; writes to the personal library go to the desktop (Zotero 10+ local writes with a user-granted key, or the connector protocol on older versions, create-only), group libraries and unsupported ops always go to the cloud. After a cloud write, reads for that library stay on the cloud until the desktop is seen to hold the write (`pending-writes.ts`); this read-after-write logic has many dedicated tests under `tests/router/`. `capabilities.ts` is the startup probe and `local-status.ts` keeps it live.

**Clients** (`src/api/`): `http.ts` is the rate-limited fetcher with backoff and Retry-After handling that all remote calls share; `web-client.ts` owns versioning, batching and retries so tools never reason about them.

**Search** (`src/features/search/`): hybrid BM25 plus vector search over metadata, own notes/annotations and PDF full text. `index-manager.ts` orchestrates builds, resume, pause, repair and corruption handling; `sqlite-index.ts` (FTS5) and the legacy JSON backend both implement `SearchIndex` (`backend.ts`), chosen by `factory.ts`. Embeddings (`embeddings.ts`) may be local on-device or a remote provider and degrade gracefully. This area has the largest test surface (`tests/features/search-*.test.ts`), one file per failure mode.

**Transports and auth**: `src/transports/stdio.ts` (default) and `http.ts` (Streamable HTTP, `--http`), with OAuth in `src/auth/` for remote and multi-tenant deployments. On stdio, stdout is the JSON-RPC stream, so all logging goes to stderr through `src/lib/logger.ts`.

**Config** is env-driven and zod-validated in `src/config.ts`; `.env.example` documents every variable. All derived data (search index, model weights, caches, granted local key) lives under `ZOTEUS_DATA_DIR`.

## Tests

- Unit and integration tests need no Zotero; `tests/global-setup.ts` redirects TMPDIR to a per-run temp directory.
- `tests/e2e/*` run only when `ZOTERO_API_KEY` is set and hit a real library. Write paths in the ordinary suite are exercised against mocks; never point them at a real library.
- `tests/tools/descriptions.test.ts` asserts that overlapping tools' descriptions cross-reference each other (search_items vs semantic_search, bibliography vs format_bibliography, scholar vs library search). Keep those assertions satisfied when editing descriptions.
- Setup files import the tool graph in `beforeAll`, not at module load, so a test file's `vi.mock` calls still take effect.
