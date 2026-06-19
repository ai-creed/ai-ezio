/**
 * @ai-ezio/surface — ezio's presentation surface: the robust markdown renderer
 * and the mounted pane renderer, plus the shared ANSI palette. Consumed by
 * ai-whisper's adapter-ai-ezio today and by the future standalone `ezio --rich`.
 */
export { renderMarkdown } from "./render-markdown.js";
export { createMountedRenderer } from "./mounted-renderer.js";
export * as style from "./style.js";
export {
	discoverSkills,
	nodeSkillFs,
	skillDirs,
	type Skill,
	type SkillDir,
	type SkillEnv,
} from "./skills.js";
export { makeClipboard } from "./clipboard.js";
export {
	resolvePager,
	showTranscript,
	transcriptFilePath,
	type TranscriptViewDeps,
} from "./transcript-view.js";
export {
	classifyLine,
	SlashController,
	runResumeFlow,
	type SlashCommand,
	type SlashContext,
	type SlashOutcome,
	type SlashSession,
	type SlashRecorder,
	type LineClass,
	type ResumeFlowDeps,
} from "./slash.js";
export {
	parseSessions,
	formatRelativeTime,
	formatRow,
	decodeChunk,
	applyKey,
	renderView,
	runResumePicker,
	PAGE_SIZE,
	type SessionRow,
	type KeyToken,
	type PickerDeps,
	type PickerState,
	type KeyResult,
} from "./resume-picker.js";
