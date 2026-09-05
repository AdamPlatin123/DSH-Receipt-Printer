import type { Config } from './index.js';
import type { ReceiptStats } from './collector.js';
export interface BridgeResult {
    ok: boolean;
    /** stdout tail from the bridge (diagnostics) */
    stdout: string;
    /** stderr from the bridge: carries the dry-run ASCII preview when enabled */
    stderr?: string;
    error?: string;
}
export declare function resolveBridgePath(config: Config): string;
export declare function runPythonBridge(config: Config, stats: ReceiptStats): Promise<BridgeResult>;
