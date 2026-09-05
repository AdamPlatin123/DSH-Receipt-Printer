export interface BalanceInfo {
    currency: string;
    total: string;
    granted: string;
    toppedUp: string;
    isAvailable: boolean;
}
/** Resolve the API key: env first, then the DSH credentials document. */
export declare function resolveApiKey(): string | undefined;
/** Cached balance fetch. Never throws; undefined on any failure or stale-call. */
export declare function fetchBalance(timeoutMs?: number): Promise<BalanceInfo | undefined>;
/** Test hook: drop the cache so the next call hits the API again. */
export declare function resetBalanceCache(): void;
