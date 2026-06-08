/**
 * Line-buffered terminal input — ezio's standalone input model (the same
 * line-buffered shape ai-whisper's mounted host uses). A pure reducer over
 * decoded keys so it is fully testable without a TTY.
 */
export interface LineBuffer {
	text: string;
}

export function newLineBuffer(): LineBuffer {
	return { text: "" };
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

const CTRL_C = "\x03";
const CTRL_D = "\x04";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";

/** Reduce one decoded key against the buffer: backspace, Ctrl-C, Ctrl-D, Enter,
 * printable. Mirrors ai-whisper's feedLineBufferedInput. */
export function feedKey(buffer: LineBuffer, ch: string): KeyResult {
	if (ch === CTRL_C) return { buffer, signal: "interrupt" };
	if (ch === CTRL_D) return { buffer, signal: "eof" };
	if (ch === "\r" || ch === "\n") {
		return { buffer: { text: "" }, submit: buffer.text, echo: "\r\n" };
	}
	if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
		if (!buffer.text) return { buffer };
		return { buffer: { text: buffer.text.slice(0, -1) }, echo: "\b \b" };
	}
	// Ignore other control chars; echo printable input.
	if (ch < " " && ch !== "\t") return { buffer };
	return { buffer: { text: buffer.text + ch }, echo: ch };
}
