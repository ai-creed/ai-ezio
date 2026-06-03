# Upstream relationship

ai-ezio is a **downstream** product derived from **hax**. We maintain our own
**fork** of hax (`ai-creed/hax`) that carries the downstream changes; the
original hax repo is treated as a read-only **sync source**, not a merge target.
We do not assume the original author wants our changes upstreamed — the
`agent_observer` seam is *designed* to be upstreamable, but the fork's viability
does not depend on it ever being merged.

## Repositories

| Role                 | Repo                                                      |
| -------------------- | --------------------------------------------------------- |
| Downstream fork (hax)| `git@github.com:ai-creed/hax.git` (private) — carries `emitter` |
| Sync source (orig.)  | `https://github.com/OleksandrChekhovskyi/hax` (read-only) |
| Downstream product   | `ai-creed/ai-ezio` (private)                              |
| Base commit          | `8fd139b5db49bd0b1d552c2530a18b547b3f4f4c` (2026-05-29)   |

## How hax is consumed

hax is vendored as a **git submodule** at `vendor/hax`, pointing at our fork
`ai-creed/hax`. The fork carries a single, small, isolated downstream change —
the **protocol emitter** — on the `emitter` branch on top of the upstream base.

```text
vendor/hax  (submodule url: git@github.com:ai-creed/hax.git, branch = emitter)
  remote: origin        -> github.com/ai-creed/hax           (our fork; push here)
  remote: hax-upstream  -> github.com/OleksandrChekhovskyi/hax (read-only sync source)
  branch: emitter       -> upstream base + agent_observer seam + emit.c + two CLI flags
  (submodule pointer in ai-ezio pins a specific emitter commit, fetchable from origin)
```

### Downstream change surface (keep it tiny)

The change is deliberately minimal and rides stable seams so it survives upstream
churn. It has two parts — an **upstreamable seam** and a **downstream emitter**:

**Upstreamable in shape (kept on the fork; upstreaming optional, not assumed):**
- one new file `src/agent_observer.h` — a general `struct agent_observer` of
  optional agent-loop lifecycle hooks (`on_ready`, `on_user_turn`,
  `on_assistant_begin`, `on_turn_finished`, `on_idle`); mirrors the existing
  `struct provider` / `struct tool` seams. Justified for any embedder
  (loggers, TUIs, automation), not just ai-ezio;
- ~5 invocation points in `agent_run` where that data is already in scope;
- two new CLI flags `--protocol-fd=<n>` / `--control-fd=<n>`.

**Downstream (ai-ezio's emitter, kept here):**
- one new file `src/protocol/emit.c` (+ header) implementing `agent_observer`,
  serializing JSONL to the protocol fd, and reading controls from the control
  fd; plus a single `on_event` hook for stream events (deltas/tools/error),
  the input-source swap for `submit`, the tick control-read for `interrupt`,
  and one `meson.build` line.

> Earlier drafts described this as "one file + 2–3 lines"; the accurate surface
> is the above. Anything beyond it is a smell — push it into the TypeScript
> harness instead.

## Keeping up with hax updates

hax is actively developed. Pull upstream periodically; rebase the small emitter
branch onto new upstream `main` (the patch surface is tiny, so conflicts are
confined to the emitter seam).

```sh
# inside the submodule
git -C vendor/hax fetch hax-upstream
git -C vendor/hax switch -c sync/hax-YYYY-MM-DD emitter
git -C vendor/hax rebase hax-upstream/master    # resolve only the emitter seam
git -C vendor/hax switch emitter
git -C vendor/hax merge --ff-only sync/hax-YYYY-MM-DD
git -C vendor/hax push origin emitter           # publish to our fork

# build + test the patched hax, then bump the submodule pointer in ai-ezio
meson setup vendor/hax/build && meson compile -C vendor/hax/build
meson test  -C vendor/hax/build --print-errorlogs
git add vendor/hax && git commit -m "chore: bump hax to <rev> (sync YYYY-MM-DD)"
```

The submodule pointer must always reference a commit pushed to `origin`
(`ai-creed/hax`); otherwise a fresh `git submodule update --init` cannot fetch it.

If a major upstream change redesigns the event model itself (the seam the
emitter rides), expect a real, but localized, port — re-anchor `emit.c` to the
new callback shape.

## Merge policy

- **Our hax changes live on the fork** (`ai-creed/hax`, `emitter` branch). We do
  not depend on the original author accepting them. Upstreaming the generic
  `agent_observer` seam is welcome if there's ever interest, but it is optional;
  the fork stands on its own.
- **Periodically rebase the `emitter` branch onto the original repo's `master`**
  (read-only sync source) so we keep getting upstream fixes — the patch surface
  is tiny, so conflicts are confined to the emitter seam.
- **ai-creed / ai-whisper-specific behavior** (protocol semantics, mount mode,
  adapter, skills UX): stays downstream in the TypeScript harness, never in hax.
- Prefer small extension seams in hax over rewriting hax core files, so rebases
  onto the sync source stay cheap.

## Downstream-only areas

- `packages/` — all TypeScript harness, protocol client, adapter, CLI.
- `docs/` — ai-ezio design and protocol docs.
- everything except `vendor/hax`.
