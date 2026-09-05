/**
 * Capture /btw (side question) and /recap LLM calls by wrapping llm.stream.
 *
 * Why a stream wrap instead of session/event: dsh-tui's sideQuestion() and
 * recap() call llm.stream() DIRECTLY with a single tool-less request - the
 * answer never enters the session log and no turn/* events fire. The only
 * observable seam is the LLM call itself, marked by the last user message's
 * `source.plugin` (`'dsh-tui/btw'` / recap equivalent) and a
 * `<system-reminder>...</system-reminder>\n\n` prompt wrapper.
 *
 * The wrap is fully reversible (dispose restores the original method) and
 * never mutates the request or chunk stream - it only observes.
 */
import type { ReceiptStats } from './collector.js';
export interface RecapCapture {
    kind: 'btw' | 'recap';
    question: string;
    answer: string;
    model: string;
}
export interface LlmStreamOptions {
    messages?: Array<{
        role?: string;
        content?: string | Array<{
            type?: string;
            text?: string;
        }>;
        source?: {
            kind?: string;
            plugin?: string;
        };
    }>;
    model?: string;
    [k: string]: unknown;
}
export interface StreamChunkLike {
    type?: string;
    text?: string;
    [k: string]: unknown;
}
/** Strip the `<system-reminder>...</system-reminder>\n\n` wrapper dsh-tui adds. */
export declare function stripReminder(wrapped: string): string;
/** Detect what kind of side call this is from the last user message's source tag. */
export declare function detectSideKind(options: LlmStreamOptions): 'btw' | 'recap' | null;
/** Pull the question text out of the last user message (handles string + block array). */
export declare function extractQuestion(options: LlmStreamOptions): string;
export interface WrapLlmResult {
    dispose: () => void;
}
/**
 * Monkey-patch `llm.stream` to observe side calls. Returns a disposer that
 * restores the original method. Never throws on malformed input.
 */
export declare function wrapLlmForRecap(llm: {
    stream: (options: LlmStreamOptions) => AsyncIterable<StreamChunkLike>;
}, onComplete: (capture: RecapCapture) => void): WrapLlmResult;
/** Attach a recap capture to the recap field on ReceiptStats. */
export declare function withRecap(stats: ReceiptStats, capture: RecapCapture): ReceiptStats;
