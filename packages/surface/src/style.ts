/**
 * ezio ANSI palette, consolidated. Both render-markdown (marked-terminal color
 * callbacks) and mounted-renderer (banner / prompt / stripe / tool output)
 * import from here, eliminating the duplicated ESC constants that previously
 * lived in each file.
 *
 * INVARIANT: ESC is the real escape byte "\u001b" — never "" (the M8 bug, which
 * made every SGR code ship as printable text like "\u001b[36m"). Source files
 * carry no literal-ESC hazard: the byte is written as the "\u001b" escape, and
 * the real control byte only ever exists at runtime.
 */

export const ESC = "\u001b";
export const RESET = `${ESC}[0m`;
export const DIM = `${ESC}[2m`;
export const BOLD = `${ESC}[1m`;
export const ITAL = `${ESC}[3m`;
export const CYAN = `${ESC}[36m`;
export const RED = `${ESC}[31m`;
export const GREEN = `${ESC}[32m`;
// Bright magenta (95), matching hax's PROMPT_UTF8 (ANSI_BRIGHT_MAGENTA) — the
// purple `❯` AND the submitted-prompt `▌ ` stripe. Regular magenta (35) is duller.
export const BRIGHT_MAGENTA = `${ESC}[95m`;
// Reset foreground only (not bold/etc), matching hax's submitted_emit row-end.
export const FG_DEFAULT = `${ESC}[39m`;
