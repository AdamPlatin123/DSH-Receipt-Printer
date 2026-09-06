/**
 * DSH Receipt Printer - DSH plugin that prints an ESC/POS thermal receipt
 * (58mm) every time a DSH turn finishes.
 *
 * Works identically in dsh-tui and dsh-desktop: both are DSH Host runtimes
 * exposing the same `session/event` seam. This plugin uses NO host-specific
 * (TUI-only / desktop-only) services, so a single subscription covers both.
 *
 * Plugin contract per @deepseek-ai/cordis v4 (Plugin.Object shape):
 *   export const name / Config (StandardSchemaV1) / apply(ctx, config)
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-receipt-printer";
export declare const usage = " Thermal Receipt - print a 58mm receipt when a DSH turn ends.\nConfig (cordis.patch.yml row \"config\"):\n  enabled        boolean  default true\n  pythonCmd      string   default \"python\"       Python interpreter with ctypes (Windows)\n  printerName    string   default \"Thermal-58\"   Win32 spooler queue name\n  trigger        enum     \"turn-end\" | \"session-end\" | \"manual\"\n  minIntervalSec number   default 60             debounce (skip if printed < N sec ago)\n  bridgePath     string   default \"\"             override path to thermal_bridge.py\n  debug          boolean  default false          bridge prints diagnostics\n";
export interface Config {
    enabled: boolean;
    pythonCmd: string;
    printerName: string;
    trigger: 'turn-end' | 'session-end' | 'manual';
    minIntervalSec: number;
    bridgePath: string;
    debug: boolean;
    /** Print a separate recap receipt for /btw side questions and /recap calls. */
    printSideCalls: boolean;
    /** Ask the LLM for a task summary at trigger time; merge into ONE receipt. */
    autoRecap: boolean;
    /** Hard cap for the auto-recap LLM call before degrading to stats-only. */
    autoRecapTimeoutSec: number;
    /** Render + log the receipt but skip the physical print (testing/CI). */
    dryRun: boolean;
}
export declare const Config: import("@standard-schema/spec").StandardSchemaV1<any, Config>;
export declare function apply(ctx: Context, config: Config): void;
export { ReceiptCollector } from './collector.js';
export type { ReceiptStats } from './collector.js';
export { RECEIPT_EVENT_TYPE, type ReceiptPrintedPayload } from './events.js';
export { runPythonBridge, resolveBridgePath, type BridgeResult } from './bridge.js';
