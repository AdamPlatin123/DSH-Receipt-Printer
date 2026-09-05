/**
 * DeepSeek account balance lookup (GET /user/balance).
 *
 * Returns CNY totals from the official endpoint. Results are cached for
 * BALANCE_TTL_MS so back-to-back receipts do not hammer the API; failures
 * resolve undefined (the renderer then omits the balance line - a balance
 * hiccup must never block the print).
 *
 * Key resolution mirrors dsh-credentials-local precedence:
 *   1. inherited DEEPSEEK_API_KEY env (highest, read-only intent)
 *   2. $DSH_HOME/.credentials.yaml (default ~/.dsh) refs.DEEPSEEK_API_KEY
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const BALANCE_TTL_MS = 5 * 60 * 1000;
let cache = null;
/** Resolve the API key: env first, then the DSH credentials document. */
export function resolveApiKey() {
    const env = process.env.DEEPSEEK_API_KEY;
    if (env && env.trim().length > 0)
        return env.trim();
    try {
        const req = createRequire(import.meta.url);
        const path = req('node:path');
        const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
        const text = readFileSync(join(home, '.credentials.yaml'), 'utf-8');
        // Minimal YAML scrape - the document is a flat ref map we control.
        const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
        return m ? m[1] : undefined;
    }
    catch {
        return undefined;
    }
}
/** Cached balance fetch. Never throws; undefined on any failure or stale-call. */
export async function fetchBalance(timeoutMs = 5000) {
    if (cache && Date.now() - cache.at < BALANCE_TTL_MS)
        return cache.info;
    const key = resolveApiKey();
    if (!key)
        return undefined;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(BALANCE_URL, {
            headers: { Authorization: `Bearer ${key}` },
            signal: ac.signal,
        });
        if (!res.ok)
            return undefined;
        const data = (await res.json());
        const first = data.balance_infos?.[0];
        if (!first)
            return undefined;
        const info = {
            currency: first.currency ?? 'CNY',
            total: first.total_balance ?? '?',
            granted: first.granted_balance ?? '?',
            toppedUp: first.topped_up_balance ?? '?',
            isAvailable: data.is_available ?? true,
        };
        cache = { at: Date.now(), info };
        return info;
    }
    catch {
        return undefined;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Test hook: drop the cache so the next call hits the API again. */
export function resetBalanceCache() {
    cache = null;
}
