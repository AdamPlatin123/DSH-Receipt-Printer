/**
 * Register our log-only event types into every reachable dsh-session copy.
 *
 * Without this, appending 'receipt/printed' via session.append() poisons the
 * session log and resume fails on the strict read path. dsh-TUI's profile
 * carries its own compat repair for third-party event types, but bare
 * compositions / Web / dsh-desktop have none - registration is mandatory.
 *
 * Implementation mirrors dsh-working-activity/src/registration.ts:
 * - two anchors (import.meta.url + process.argv[1]) to find reachable copies
 * - idempotent (re-registration is a no-op)
 * - never throws (registration failure must not block plugin load)
 */
import { createRequire } from 'node:module';
import { RECEIPT_EVENT_TYPE } from './events.js';
const CANDIDATE_MODULES = [
    '@deepseek-ai/dsh-session',
    'dsh-session',
    '@deepseek-ai/dsh-session/types',
];
const KNOWN_KEY = 'KNOWN_SESSION_EVENT_TYPES';
function addToKnown(mod) {
    if (!mod)
        return false;
    const known = mod[KNOWN_KEY];
    if (known instanceof Set) {
        known.add(RECEIPT_EVENT_TYPE);
        return true;
    }
    if (Array.isArray(known)) {
        if (!known.includes(RECEIPT_EVENT_TYPE))
            known.push(RECEIPT_EVENT_TYPE);
        return true;
    }
    return false;
}
export function registerReceiptEventTypes() {
    try {
        const anchors = [import.meta.url, process.argv[1]].filter(Boolean);
        const seen = new Set();
        for (const anchor of anchors) {
            const req = createRequire(anchor);
            for (const id of CANDIDATE_MODULES) {
                let resolved;
                try {
                    resolved = req.resolve(id);
                }
                catch {
                    continue;
                }
                if (seen.has(resolved))
                    continue;
                seen.add(resolved);
                try {
                    const mod = req(resolved);
                    if (addToKnown(mod))
                        return;
                    // The types-only entry may re-export the runtime record - try default too
                    if (mod && typeof mod === 'object' && 'default' in mod) {
                        addToKnown(mod.default);
                    }
                }
                catch {
                    // unreachable copy - keep scanning other anchors
                }
            }
        }
    }
    catch {
        // Never throw from registration: a missing dsh-session copy just means
        // we are running outside a full DSH host (e.g. unit tests).
    }
}
