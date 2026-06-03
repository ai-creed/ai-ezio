# ai-ezio skills

How ai-ezio discovers skills, which directories it honors, and how that relates
to the hax engine. This is the decision record for the M2 "skills sharing" open
question (see `docs/milestones.md` M2 and `docs/superpowers/plans`).

## What a skill is

A skill is a directory containing a `SKILL.md` file with optional YAML
frontmatter. The `description:` field (when present) is what the agent matches a
task against:

```text
<skills-dir>/
  my-skill/
    SKILL.md      # frontmatter: description: <when to use this skill>
```

This is exactly hax's format (`vendor/hax/src/agent_env.c`): ai-ezio does not
invent a new skill artifact — a `SKILL.md` skill is portable between hax and
ai-ezio.

## Honored directories (precedence high → low)

| # | Source           | Path                                                        | Engine-visible |
| - | ---------------- | ----------------------------------------------------------- | -------------- |
| 1 | `project`        | `<cwd>/.agents/skills/`                                      | **yes**        |
| 2 | `ai-ezio-global` | `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills/`         | no (see below) |
| 3 | `hax-global`     | `${XDG_CONFIG_HOME:-$HOME/.config}/hax/skills/`             | **yes**        |

Precedence: a skill in a higher row **shadows** a same-named skill in a lower
row. `skill list` reports the winning entry; `skill dirs` lists all three
directories with their source and whether each exists.

## Engine visibility (important caveat)

The hax engine builds the model's "# Skills" prompt section from **only** the
directories *it* reads — `<cwd>/.agents/skills/` and the hax-global dir
(`.../hax/skills/`). It has no knowledge of the ai-ezio-global dir.

So a skill placed in `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills/` is:

- **listed** by `ai-ezio skill list` and counted by `ai-ezio doctor`, but
- **not yet injected** into the running engine's prompt.

`ai-ezio doctor` flags this explicitly (an info note per ai-ezio-global skill).
Bridging the ai-ezio-global dir into the engine prompt requires ai-ezio to
control the launch environment, which lands with mounted mode (M3/M4) — e.g. by
pointing the engine at a merged view or via a future hax knob. Until then, for a
skill that must reach the model, install it into `.agents/skills/` (project) or
the hax-global dir.

## Why this layout

- **Reuse hax's dirs** keeps a single shared skill artifact: install once, works
  in both hax and ai-ezio, no fork of hax's discovery.
- **Add an ai-ezio-global dir** gives ai-ezio a namespace of its own for
  ai-ezio-specific skills without polluting the hax config tree, at the cost of
  the engine-visibility gap documented above.

## Installing an ai-whisper skill (M2 verification)

ai-whisper skills are `SKILL.md` directories. Dropping one into
`<cwd>/.agents/skills/<name>/` (project) makes it both engine-visible and listed
by `ai-ezio skill list`. The first-class `whisper skill install --target ai-ezio`
path is wired in M6; M2 only verifies discovery of a correctly-placed skill.

## Commands

- `ai-ezio skill dirs` — list honored directories, their source, and existence.
- `ai-ezio skill list` — list discovered skills (after shadowing), with source
  and engine-visibility.
- `ai-ezio doctor` — engine binary resolution + skill directory health.

Interactive `/skills` in the REPL is **moved out of M2 to M4 (mounted mode)**,
which is where ai-ezio first owns a control/input channel (built on the M3
protocol). Adding it in M2 would mean scraping or growing the hax patch beyond
the emitter seam (`UPSTREAM.md`). It reuses this module's discovery, so it is
purely a UX surface in M4. See `docs/milestones.md` (M4) and the plan.
