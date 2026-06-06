/**
 * @ai-ezio/surface — ezio's presentation surface: the robust markdown renderer
 * and the mounted pane renderer, plus the shared ANSI palette. Consumed by
 * ai-whisper's adapter-ai-ezio today and by the future standalone `ezio --rich`.
 */
export { renderMarkdown } from "./render-markdown.js";
export { createMountedRenderer } from "./mounted-renderer.js";
export * as style from "./style.js";
