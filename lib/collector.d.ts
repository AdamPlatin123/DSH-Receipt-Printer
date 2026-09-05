/**
 * ReceiptCollector: consume DSH session events, aggregate per-session stats,
 * and hand off to the Python bridge on the configured trigger.
 *
 * Subscribes ONLY to the core `session/event` / `session/disposed` seams -
 * these are owned by the DSH Host, so the same code path works in dsh-tui
 * (TTY) and dsh-desktop (Electron/Web) without any UI-specific service.
 *
 * Event shapes (per dsh-TUI plugin guide, "Seam 1"):
 *   event.type: 'turn/start' | 'assistant/chunk' | 'tool/call' | 'tool/result'
 *             | 'turn/end' | ...
 * We defensively type everything as loose records: dsh-tui and dsh-desktop
 * both run DSH Host, but exact payload fields can drift across versions.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './index.js';
export interface ReceiptStats {
    sessionId: string;
    project: string;
    startedAt: string;
    endedAt: string;
    durationSec: number;
    model: string;
    turns: number;
    toolCalls: Record<string, number>;
    filesWritten: string[];
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    thinkingTokens: number;
    trigger: string;
    host: string;
    /** Present for /btw, /recap side calls AND plugin-initiated auto recaps. */
    recap?: {
        kind: 'btw' | 'recap' | 'auto';
        question: string;
        answer: string;
        model: string;
    };
    /** CNY cost estimated from the official DeepSeek rate card (peak-aware). */
    costCny?: number;
    /** Whether the billable window was peak (Beijing weekday 9-12, 14-18). */
    isPeak?: boolean;
    /** Account balance from GET /user/balance, CNY. Undefined on failure. */
    balanceCny?: string;
}
export declare class ReceiptCollector {
    private ctx;
    private config;
    private acc;
    private disposers;
    private lastPrintMs;
    private printInFlight;
    private recapWrap;
    private recapWrapTried;
    constructor(ctx: Context, config: Config);
    /** Wrap llm.stream to catch /btw and /recap side calls (retry lazily once). */
    private tryWrapLlm;
    /** Print one recap receipt for a /btw or /recap side call. */
    private printRecap;
    private bind;
    private onEvent;
    /** Debounce: never print more often than config.minIntervalSec. */
    private maybePrint;
    /** Manual trigger (slash command hook). */
    printNow(sessionId?: string): void;
    private detectHost;
    dispose(): void;
}
