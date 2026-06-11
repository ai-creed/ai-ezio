# Whisper runs a stale prebuilt ezio bundle (mounted-mode fixes don't propagate from an ezio npm release)

**Project:** ai-ezio · **Date:** 2026-06-11 · **Status:** diagnosed (fix deferred until the running collab finishes)
**Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/knowledge-references/2026-06-11-whisper-stale-ezio-bundle.md`
(this in-repo copy is the committable mirror of that canonical doc).

## TL;DR

In **mounted mode**, ezio's surface rendering and MCP host run **inside
ai-whisper**, not in the standalone `ai-ezio` CLI. ai-whisper esbuild-bundles the
`@ai-ezio/*` packages into its own `dist` at *its* build time. So publishing a new
`ai-ezio` npm release and upgrading the global ezio CLI does **not** change what a
mounted collab runs — only rebuilding ai-whisper (and reinstalling its global
binary) does.

## Symptom

After publishing `ai-ezio@0.2.0-beta.1` (which carried two fixes — cortex
stderr-leak suppression and the markdown list-item inline-rendering fix) and
running `npm i -g @ai-creed/ai-ezio@beta`, both bugs still appeared in a mounted
ezio session under a `whisper` collab — and persisted across a collab restart.

## Root cause (the topology)

- The upgraded artifact is the **standalone ezio CLI** (`@ai-creed/ai-ezio`) — but
  the mounted collab never runs that CLI. Per ezio's unified architecture, hax is
  always headless (protocol on fd 3 / controls on fd 4) and the **TS side owns the
  terminal**; in mounted mode the host application *is* ai-whisper.
- ai-whisper's adapter imports `@ai-ezio/harness` (spawns headless hax),
  `@ai-ezio/surface` (renders markdown from protocol events), and
  `@ai-ezio/mcp-host` (hosts cortex over MCP) — all running **inside the
  ai-whisper process**, not in any ezio binary.
- ai-whisper depends on ezio via local `file:../ai-ezio/packages/*` deps and
  **esbuild-bundles those packages into its own `dist`** at ai-whisper build time.
  The bundled copy is a snapshot frozen at that build — not the live ezio source
  and not the global ezio CLI.
- The collab runs the **globally installed** `whisper`:
  `/opt/homebrew/lib/node_modules/ai-whisper@0.5.5`, built **2026-06-09 01:23** —
  before either fix existed (cortex stderr fix: 06-10; markdown fix: 06-11).

## Evidence

Grepping the global bundle (`dist/bin/whisper.js`, `dist/bin/companion-agent.js`):

| signal | result |
| --- | --- |
| markdown `text()` renderer override (`parseInline(token.tokens)`) | **absent (0)** |
| cortex `stderr: "ignore"` on the MCP transport | **absent (0)** |
| old `marked-terminal` list path | still present |

For contrast, ai-whisper's *source* deps were already current: its
`node_modules/@ai-ezio/surface/dist/render-markdown.js` is the **same inode** as
the fixed ai-ezio source dist — it simply had not been re-bundled into ai-whisper's
shipped artifact.

## The decoupling rule

Publishing `ai-ezio` does **not** propagate to mounted mode. Because ai-whisper
inlines the `@ai-ezio/*` packages at its own build time, any ezio change that
affects mounted behavior reaches a collab **only after ai-whisper is rebuilt
against current ezio and its global binary is reinstalled**. The ezio npm release
is necessary for standalone users but irrelevant to the bundled mounted path.

## Resolution (deferred until the running collab workflow completes)

A rebuild + global reinstall yanks the bundle out from under a live collab, so it
must wait for the in-flight workflow to finish.

1. `cd ~/Dev/ai-whisper`
2. `pnpm install` — refresh the `file:` ezio deps
3. `pnpm -r build` — re-bundle, inlining the fixed `@ai-ezio/surface` + `@ai-ezio/mcp-host`
4. reinstall the global `whisper` from the fresh build
5. restart the collab → both fixes live in mounted mode

## Verification target

After the rebuild, the global `whisper` bundle should show the markdown `text()`
override **and** `stderr: "ignore"` present — the inverse of the current grep
result.

## General lesson

When a downstream consumer **bundles** a dependency at build time (esbuild inline
of `file:`/workspace deps), shipping a fix in the dependency is not enough — the
consumer must rebuild and redeploy. Treat "rebuild + reinstall the consumer" as a
required step of any ezio fix that affects mounted/embedded behavior.
