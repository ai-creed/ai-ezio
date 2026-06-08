/**
 * Line-buffered terminal input — ezio's standalone input model (the same
 * line-buffered shape ai-whisper's mounted host uses). A pure reducer over
 * decoded keys so it is fully testable without a TTY.
 *
 * Multiline: Alt+Enter (the terminal sends ESC then CR/LF) inserts a newline
 * instead of submitting, and a bracketed paste (ESC[200~ … ESC[201~) buffers a
 * whole block — embedded newlines stay literal — so a pasted snippet arrives as
 * one prompt rather than submitting at its first line break. A plain Enter
 * outside a paste still submits the (now possibly multiline) buffer.
 *
 * NOTE: backspacing across a newline has imperfect echo (a raw `\b \b` can't
 * walk back up a line); the buffer text is always correct, but a full visual
 * fix would need a redraw-style line editor — out of scope here.
 */
export interface LineBuffer {
	text: string;
	/** In-progress ESC sequence (Alt+Enter or a paste marker), awaiting more
	 * bytes. Empty when not mid-sequence. */
	pending: string;
	/** True between a bracketed-paste start and end marker. */
	pasting: boolean;
}

export function newLineBuffer(): LineBuffer {
	return { text: "", pending: "", pasting: false };
}

export interface KeyResult {
	buffer: LineBuffer;
	/** Set when Enter completed a line (the submitted text, possibly empty). */
	submit?: string;
	/** Out-of-band signals: Ctrl-C interrupts, Ctrl-D exits. */
	signal?: "interrupt" | "eof";
	/** Bytes to echo to the terminal (printable char or erase sequence). */
	echo?: string;
}

const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";

/** Recognized ESC sequences → action. Alt+Enter arrives as ESC then CR or LF;
 * bracketed paste brackets the pasted block with these markers. */
const ESC_SEQUENCES: Record<string, "alt-enter" | "paste-start" | "paste-end"> = {
	"\x1b\r": "alt-enter",
	"\x1b\n": "alt-enter",
	"\x1b[200~": "paste-start",
	"\x1b[201~": "paste-end",
};

type EscMatch =
	| { kind: "complete"; action: "alt-enter" | "paste-start" | "paste-end" }
	| { kind: "prefix" }
	| { kind: "none" };

/** Classify an accumulated ESC sequence: a full match, a strict prefix of one
 * (keep reading), or unrecognized. */
function matchEsc(pending: string): EscMatch {
	const action = ESC_SEQUENCES[pending];
	if (action) return { kind: "complete", action };
	for (const seq of Object.keys(ESC_SEQUENCES)) {
		if (seq.startsWith(pending)) return { kind: "prefix" };
	}
	return { kind: "none" };
}

/** Reduce one decoded key against the buffer. Handles ESC sequences (Alt+Enter,
 * paste markers), bracketed-paste content, and ordinary line editing. */
export function feedKey(buffer: LineBuffer, ch: string): KeyResult {
	// 1) Accumulate / resolve an ESC sequence. Active while mid-sequence or when a
	//    fresh ESC arrives — in or out of a paste (the paste-end marker is ESC-led).
	if (buffer.pending || ch === ESC) {
		const pending = buffer.pending + ch;
		const m = matchEsc(pending);
		if (m.kind === "prefix") return { buffer: { ...buffer, pending } };
		if (m.kind === "complete") {
			const base = { ...buffer, pending: "" };
			if (m.action === "alt-enter")
				return { buffer: { ...base, text: base.text + "\n" }, echo: "\r\n" };
			if (m.action === "paste-start") return { buffer: { ...base, pasting: true } };
			return { buffer: { ...base, pasting: false } }; // paste-end
		}
		// Unrecognized: inside a paste the bytes are literal content (lossless);
		// outside, drop the unsupported escape rather than echo control junk.
		const base = { ...buffer, pending: "" };
		if (base.pasting) return { buffer: { ...base, text: base.text + pending } };
		return { buffer: base };
	}

	// 2) Inside a bracketed paste: newlines are literal, content is buffered (never
	//    submitted) until the end marker arrives.
	if (buffer.pasting) {
		if (ch === "\r" || ch === "\n")
			return { buffer: { ...buffer, text: buffer.text + "\n" }, echo: "\r\n" };
		if (ch < " " && ch !== "\t") return { buffer }; // drop stray control bytes
		return { buffer: { ...buffer, text: buffer.text + ch }, echo: ch };
	}

	// 3) Ordinary line editing.
	if (ch === CTRL_C) return { buffer, signal: "interrupt" };
	if (ch === CTRL_D) return { buffer, signal: "eof" };
	if (ch === "\r" || ch === "\n") {
		return { buffer: newLineBuffer(), submit: buffer.text, echo: "\r\n" };
	}
	if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
		if (!buffer.text) return { buffer };
		return { buffer: { ...buffer, text: buffer.text.slice(0, -1) }, echo: "\b \b" };
	}
	// Ignore other control chars; echo printable input.
	if (ch < " " && ch !== "\t") return { buffer };
	return { buffer: { ...buffer, text: buffer.text + ch }, echo: ch };
}
