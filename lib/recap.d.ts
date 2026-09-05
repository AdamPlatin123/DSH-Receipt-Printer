import type { ReceiptStats } from './collector.js';
export interface RecapLlm {
    stream: (options: unknown) => AsyncIterable<{
        type?: string;
        text?: string;
    }>;
}
/**
 * Natural-language recap prompt: no hard per-line caps or fixed three-section
 * template - just tell the model what a receipt reads like and let it write.
 * The rendering side (wrap_text with max_lines=None + total cap 8 lines)
 * owns the physical constraints, so the prompt stays guidance-only.
 */
export declare function buildRecapPrompt(stats: ReceiptStats): string;
/**
 * Generate the recap answer. Returns the trimmed text, or undefined when the
 * llm service is unavailable / the stream yields nothing. Never throws to
 * the caller (catches its own errors and returns undefined).
 *
 * provider/model MUST be set: the llm service routes by provider, and a
 * missing provider yields `finish{reason:{kind:'error',
 * failure:{message:'no adapter registered for provider "undefined"'}}}`
 * with zero text chunks.
 */
export interface RecapRoute {
    provider: string;
    model: string;
}
export declare function generateRecap(llm: RecapLlm | undefined, stats: ReceiptStats, timeoutMs?: number, route?: RecapRoute): Promise<string | undefined>;
