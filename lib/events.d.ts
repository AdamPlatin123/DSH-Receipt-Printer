/**
 * Log-only session event types this plugin appends (never model-visible).
 *
 * Hard rule from the dsh-TUI plugin guide: appending an unregistered event
 * type makes the whole session UNRESUMABLE, because dsh-session's strict
 * read path refuses logs with unknown non-ignorable event types. The
 * registration itself lives in ./registration.ts (same dual-anchor trick
 * dsh-working-activity uses).
 */
/** Fired once per printed receipt; payload is UI/debug-only. */
export interface ReceiptPrintedPayload {
    sessionId: string;
    turnCount: number;
    toolCalls: number;
    totalTokens: number;
    printerName: string;
    /** ISO timestamp */
    at: string;
    /** true when the Python bridge reported success */
    ok: boolean;
    /** non-empty on failure */
    error?: string;
}
/** Type-declaration merging lives in ./dsh-session.d.ts (ambient script). */
export declare const RECEIPT_EVENT_TYPE = "receipt/printed";
