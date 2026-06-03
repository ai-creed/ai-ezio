# ai-ezio development

How to build, test, and run ai-ezio locally. See `docs/architecture.md` for the
design and `docs/superpowers/plans/2026-06-03-ai-ezio.md` for the milestone plan.

## Toolchain prerequisites

TypeScript harness (`packages/`):

- Node LTS (>= 20; tested on Node 22/25)
- pnpm (>= 9)

C engine (`vendor/hax`, built locally as a submodule):

- meson + ninja
- a C11 compiler (clang or gcc)
- libcurl + jansson (via pkg-config)
- `clang-format` (only needed when editing hax C, e.g. the M3 emitter)

On macOS: `brew install meson ninja jansson pkg-config`.
On Debian/Ubuntu: `apt install meson ninja-build libjansson-dev libcurl4-openssl-dev pkg-config`.

## First-time setup

```sh
git submodule update --init                 # fetch vendor/hax at the pinned commit
pnpm install                                # TS deps + workspace links
meson setup vendor/hax/build                # configure the engine build
meson compile -C vendor/hax/build           # build the hax binary
pnpm -r build                               # build the TS packages
```

## Test

```sh
pnpm -r build && pnpm -r test               # TS unit tests (vitest)
meson test -C vendor/hax/build              # engine tests
pnpm run smoke:install                      # single-install acceptance (M1 gate)
```

The smoke test packs the workspace, installs it into a clean temp dir with no
`vendor/hax` and `AI_EZIO_HAX_BIN` unset, and proves `ai-ezio` resolves the hax
binary from the `@ai-ezio/hax-<os>-<cpu>` platform package — i.e. one install
produces a working `ai-ezio` with the engine embedded.

## Run (dev)

```sh
node packages/cli/bin/ai-ezio.mjs --version --json   # ezio version + hax base commit
node packages/cli/bin/ai-ezio.mjs                    # interactive REPL passthrough
node packages/cli/bin/ai-ezio.mjs -p "list the TODOs" # one-shot
HAX_PROVIDER=mock node packages/cli/bin/ai-ezio.mjs -p "hi"  # offline, deterministic
```

In dev, the binary resolver falls back to `vendor/hax/build/hax` (resolution
order: `AI_EZIO_HAX_BIN` → `@ai-ezio/hax-<os>-<cpu>` package → dev fallback).

## hax binary resolution

`@ai-ezio/harness`'s `resolveHaxBinary()` resolves, in order:

1. `AI_EZIO_HAX_BIN` env override;
2. the matching `@ai-ezio/hax-<os>-<cpu>` package (`require.resolve`);
3. `vendor/hax/build/hax` dev fallback.

Failure throws `HaxBinaryNotFoundError` pointing at `ai-ezio doctor` (added M2).

## Updating hax

See `UPSTREAM.md` — rebase the tiny `emitter` branch onto upstream `main`,
rebuild, then bump the submodule pointer.
