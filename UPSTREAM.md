# Upstream relationship

ai-ezio is a **downstream** product derived from **hax**. hax is the upstream;
ai-ezio adds workflow-native behavior on top without trying to grow hax itself.

## Repositories

| Role             | Repo                                                  |
| ---------------- | ----------------------------------------------------- |
| Upstream (hax)   | `https://github.com/OleksandrChekhovskyi/hax`         |
| Downstream       | ai-ezio (private)                                     |
| Base commit      | `8fd139b5db49bd0b1d552c2530a18b547b3f4f4c` (2026-05-29) |

## How hax is consumed

hax is vendored as a **git submodule** at `vendor/hax`. ai-ezio does not fork
hax wholesale; it carries a single, small, isolated downstream change — the
**protocol emitter** — on a dedicated branch on top of upstream `main`.

```text
vendor/hax
  remote: hax-upstream  -> github.com/OleksandrChekhovskyi/hax
  branch: emitter       -> upstream/main + src/protocol/emit.c + two CLI flags
  (submodule pointer in ai-ezio pins a specific emitter commit)
```

### Downstream change surface (keep it tiny)

The emitter is deliberately minimal so it survives upstream churn and can be
proposed back upstream:

- one new file: `src/protocol/emit.c` (+ header), hooking the existing
  `turn` `on_event(struct stream_event *)` callback;
- two new CLI flags: `--protocol-fd=<n>` and `--control-fd=<n>`;
- ~2-3 lines in existing files to register the callback and parse the flags;
- one line in `meson.build` to compile the new source.

Anything beyond this seam is a smell — push it into the TypeScript harness
instead.

## Keeping up with hax updates

hax is actively developed. Pull upstream periodically; rebase the small emitter
branch onto new upstream `main` (the patch surface is tiny, so conflicts are
confined to the emitter seam).

```sh
# inside the submodule
git -C vendor/hax fetch hax-upstream
git -C vendor/hax switch -c sync/hax-YYYY-MM-DD emitter
git -C vendor/hax rebase hax-upstream/main      # resolve only the emitter seam
git -C vendor/hax switch emitter
git -C vendor/hax merge --ff-only sync/hax-YYYY-MM-DD

# build + test the patched hax, then bump the submodule pointer in ai-ezio
meson setup vendor/hax/build && meson compile -C vendor/hax/build
meson test  -C vendor/hax/build --print-errorlogs
git add vendor/hax && git commit -m "chore: bump hax to <rev> (sync YYYY-MM-DD)"
```

If a major upstream change redesigns the event model itself (the seam the
emitter rides), expect a real, but localized, port — re-anchor `emit.c` to the
new callback shape.

## Merge policy

- **Generic fixes / improvements** (provider bugs, streaming, tools, the
  emitter itself): contribute back to hax upstream as PRs. Prefer upstreaming
  the emitter entirely — if accepted, the downstream patch disappears and the
  submodule just tracks upstream `main`.
- **ai-creed / ai-whisper-specific behavior** (protocol semantics, mount mode,
  adapter, skills UX): stays downstream in the TypeScript harness, never in hax.
- Prefer small extension seams in hax over rewriting hax core files.

## Downstream-only areas

- `packages/` — all TypeScript harness, protocol client, adapter, CLI.
- `docs/` — ai-ezio design and protocol docs.
- everything except `vendor/hax`.
