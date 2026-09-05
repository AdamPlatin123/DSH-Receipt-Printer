import { createRequire } from 'node:module';
import { runPythonBridge } from './bridge.js';
import { RECEIPT_EVENT_TYPE } from './events.js';
import { wrapLlmForRecap, withRecap } from './btw.js';
import { generateRecap } from './recap.js';
import { computeCostCny, isPeakHour } from './pricing.js';
import { fetchBalance } from './balance.js';
/** Per-session aggregation state. */
class SessionAccumulator {
    startedAt = new Date();
    lastActivity = new Date();
    turns = 0;
    toolCalls = {};
    filesWritten = [];
    inputTokens = 0;
    outputTokens = 0;
    cacheReadTokens = 0;
    thinkingTokens = 0;
    model = '';
    costCny = 0;
    /**
     * Absorb one DSH session event. Real event shape (dsh-session/types/types.d.ts):
     *   { type, seq, time, data } - payload lives in `.data`, camelCase fields.
     *   'turn/start'       data: { turn }
     *   'turn/end'         data: { turn, reason }
     *   'tool/call'        data: { turn, step, callId, name, arguments: JSON-string }
     *   'assistant/message' data: { turn, step, message, usage?: TokenUsage }
     */
    absorb(ev) {
        this.lastActivity = new Date();
        const d = (ev.data ?? {});
        switch (ev.type) {
            case 'turn/start':
                this.turns += 1;
                break;
            case 'tool/call': {
                const name = String(d.name ?? '?');
                this.toolCalls[name] = (this.toolCalls[name] ?? 0) + 1;
                try {
                    const args = JSON.parse(String(d.arguments ?? '{}'));
                    const fp = args?.file_path ?? args?.filePath ?? args?.path;
                    if (typeof fp === 'string' && fp && !this.filesWritten.includes(fp)) {
                        this.filesWritten.push(fp);
                    }
                }
                catch {
                    /* model-produced arguments may be malformed JSON - ignore */
                }
                break;
            }
            case 'assistant/message': {
                const usage = d.usage;
                const msg = d.message;
                const model = typeof msg?.model === 'string' ? msg.model : this.model;
                if (typeof model === 'string' && model && !this.model)
                    this.model = model;
                if (usage && typeof usage === 'object') {
                    const inTok = Number(usage.inputTokens ?? 0) || 0;
                    const outTok = Number(usage.outputTokens ?? 0) || 0;
                    // DSH reports cacheRead (hit) and cacheWrite separately; the official
                    // bill prices input as (input - cacheRead) at miss + cacheRead at hit,
                    // and cacheWrite is ALREADY inside input's miss side (dsh-tui rule).
                    const hitTok = Number(usage.cacheReadTokens ?? 0) || 0;
                    this.inputTokens += inTok;
                    this.outputTokens += outTok;
                    this.cacheReadTokens += hitTok;
                    // Per-message cost at the message's own timestamp (peak-aware, CNY).
                    if (model) {
                        const c = computeCostCny(model, inTok, hitTok, outTok, new Date());
                        if (c !== undefined)
                            this.costCny += c;
                    }
                }
                break;
            }
        }
    }
    toStats(sessionId, trigger, host) {
        const end = this.lastActivity;
        return {
            sessionId,
            project: process.cwd().split(/[\\/]/).pop() ?? 'unknown',
            startedAt: this.startedAt.toISOString(),
            endedAt: end.toISOString(),
            durationSec: Math.max(0, Math.round((end.getTime() - this.startedAt.getTime()) / 1000)),
            model: this.model,
            turns: this.turns,
            toolCalls: this.toolCalls,
            filesWritten: this.filesWritten.slice(0, 12),
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheReadTokens: this.cacheReadTokens,
            thinkingTokens: this.thinkingTokens,
            trigger,
            host,
            costCny: this.costCny > 0 ? this.costCny : undefined,
            isPeak: isPeakHour(this.lastActivity),
        };
    }
}
export class ReceiptCollector {
    ctx;
    config;
    acc = new Map();
    disposers = [];
    lastPrintMs = 0;
    printInFlight = false;
    recapWrap = null;
    recapWrapTried = false;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
        this.bind();
        this.tryWrapLlm();
    }
    /** Wrap llm.stream to catch /btw and /recap side calls (retry lazily once). */
    tryWrapLlm() {
        if (this.recapWrap || this.recapWrapTried)
            return;
        if (this.config.printSideCalls === false)
            return;
        this.recapWrapTried = true;
        const llm = this.ctx.get?.('llm', false);
        if (!llm || typeof llm.stream !== 'function')
            return;
        this.recapWrap = wrapLlmForRecap(llm, (capture) => this.printRecap(capture));
        this.disposers.push(() => this.recapWrap?.dispose());
    }
    /** Print one recap receipt for a /btw or /recap side call. */
    printRecap(capture) {
        const id = 'recap-' + Date.now().toString(36);
        const acc = new SessionAccumulator();
        acc.model = capture.model;
        const stats = withRecap(acc.toStats(id, capture.kind, this.detectHost()), capture);
        if (process.env.THERMAL_DEBUG === '1') {
            try {
                const req = createRequire(import.meta.url);
                const fs = req('node:fs');
                fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[recap] kind=${capture.kind} q=${capture.question.slice(0, 60)} a=${capture.answer.length}ch\n`);
            }
            catch { /* never break */ }
        }
        runPythonBridge(this.config, stats)
            .then(result => {
            if (process.env.THERMAL_DEBUG === '1') {
                try {
                    const req = createRequire(import.meta.url);
                    const fs = req('node:fs');
                    fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[recap-bridge] ok=${result.ok} stdout=${result.stdout.trim().slice(0, 120)}\n`);
                }
                catch { /* never break */ }
            }
            if (!result.ok) {
                this.ctx.logger?.warn?.(`thermal-receipt recap: ${result.error ?? 'print failed'}`);
            }
        })
            .catch(err => {
            this.ctx.logger?.warn?.(`thermal-receipt recap bridge crashed: ${String(err)}`);
        });
    }
    bind() {
        const off1 = this.ctx.on('session/event', ((session, event) => {
            this.onEvent(session, event);
        }));
        const off2 = this.ctx.on('session/disposed', ((session) => {
            if (this.config.trigger === 'session-end') {
                this.maybePrint(session, 'session-end', true);
            }
            this.acc.delete(String(session?.id ?? session ?? ''));
        }));
        this.disposers.push(off1, off2);
    }
    onEvent(session, event) {
        if (!event || typeof event.type !== 'string')
            return;
        // Lazy retry: llm service may mount after our apply() - hook it on the
        // first observable session event so early /btw calls are still caught.
        this.tryWrapLlm();
        if (process.env.THERMAL_DEBUG === '1') {
            // Debug-only: dump real DSH event types so integration mismatches are visible
            const brief = { type: event.type, keys: Object.keys(event).slice(0, 12).join(',') };
            this.ctx.logger?.info?.(`thermal-receipt [debug] ${JSON.stringify(brief)}`);
        }
        if (event.type === RECEIPT_EVENT_TYPE)
            return; // don't loop on our own log events
        const id = String(session?.id ?? 'unknown');
        let acc = this.acc.get(id);
        if (!acc) {
            acc = new SessionAccumulator();
            this.acc.set(id, acc);
        }
        acc.absorb(event);
        if (event.type === 'turn/end' && this.config.trigger === 'turn-end') {
            this.maybePrint(session, 'turn-end');
        }
    }
    /** Debounce: never print more often than config.minIntervalSec. */
    maybePrint(session, trigger, flush = false) {
        const now = Date.now();
        const minMs = this.config.minIntervalSec * 1000;
        if (!flush && this.lastPrintMs > 0 && now - this.lastPrintMs < minMs)
            return;
        if (this.printInFlight)
            return;
        this.printInFlight = true;
        this.lastPrintMs = now;
        const id = String(session?.id ?? 'unknown');
        const acc = this.acc.get(id) ?? new SessionAccumulator();
        const stats = acc.toStats(id, trigger, this.detectHost());
        // Debug marker: proves maybePrint reached the spawn point
        if (process.env.THERMAL_DEBUG === '1') {
            try {
                const req = createRequire(import.meta.url);
                const fs = req('node:fs');
                fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[maybePrint] trigger=${trigger} session=${id} tools=${JSON.stringify(acc.toolCalls)} turns=${acc.turns}\n`);
            }
            catch { /* never break */ }
        }
        // Auto-recap flow: ask the LLM for a task summary first, then merge it
        // with the stats into ONE receipt. Failures/timeouts degrade to stats-only.
        const finalize = (recapText, balanceCny) => {
            if (recapText) {
                stats.recap = {
                    kind: 'auto',
                    question: '',
                    answer: recapText,
                    model: acc.model,
                };
            }
            if (balanceCny)
                stats.balanceCny = balanceCny;
            runPythonBridge(this.config, stats)
                .then(result => {
                if (process.env.THERMAL_DEBUG === '1') {
                    try {
                        const req = createRequire(import.meta.url);
                        const fs = req('node:fs');
                        fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[bridge-result] ok=${result.ok} recap=${recapText ? recapText.length + 'ch' : 'none'} stdout=${result.stdout.trim().slice(0, 120)}\n` +
                            (result.stderr ? `[receipt-preview]\n${result.stderr.trim()}\n[/receipt-preview]\n` : ''));
                    }
                    catch { /* never break */ }
                }
                const payload = {
                    sessionId: id,
                    turnCount: stats.turns,
                    toolCalls: Object.values(stats.toolCalls).reduce((a, b) => a + b, 0),
                    totalTokens: stats.inputTokens + stats.outputTokens + stats.cacheReadTokens,
                    printerName: this.config.printerName,
                    at: new Date().toISOString(),
                    ok: result.ok,
                    error: result.error,
                };
                try {
                    session?.append?.(RECEIPT_EVENT_TYPE, payload);
                }
                catch {
                    // log-only append failure must never bubble
                }
                if (!result.ok)
                    this.ctx.logger?.warn?.(`thermal-receipt: ${result.error ?? 'print failed'}`);
                else
                    this.ctx.logger?.info?.(`thermal-receipt: printed (turns=${stats.turns} recap=${recapText ? 'yes' : 'no'})`);
            })
                .catch(err => {
                this.ctx.logger?.warn?.(`thermal-receipt: bridge crashed: ${String(err)}`);
            })
                .finally(() => {
                this.printInFlight = false;
            });
        };
        if (this.config.autoRecap) {
            const llm = this.ctx.get?.('llm', false);
            if (process.env.THERMAL_DEBUG === '1') {
                try {
                    const req = createRequire(import.meta.url);
                    const fs = req('node:fs');
                    fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[auto-recap] llm=${llm ? 'yes' : 'NO'} stream=${llm && typeof llm.stream === 'function' ? 'yes' : 'NO'}\n`);
                }
                catch { /* never break */ }
            }
            // Route the recap call through the live session's provider/model when
            // the header carries them (same source /btw uses); fall back to the
            // profile default otherwise.
            const header = session
                ?.requestHeader?.();
            const route = {
                provider: String(header?.config?.provider ?? ''),
                model: String(header?.config?.model ?? acc.model ?? ''),
            };
            generateRecap(llm, stats, this.config.autoRecapTimeoutSec * 1000, route)
                .then(async (recapText) => {
                if (process.env.THERMAL_DEBUG === '1') {
                    try {
                        const req = createRequire(import.meta.url);
                        const fs = req('node:fs');
                        fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[auto-recap] answer=${recapText ? recapText.length + 'ch' : 'none'}\n`);
                    }
                    catch { /* never break */ }
                }
                // Balance rides along the recap wait: 5s cap, cached, failure silent.
                const bal = await fetchBalance();
                finalize(recapText, bal?.total);
            })
                .catch(err => {
                if (process.env.THERMAL_DEBUG === '1') {
                    try {
                        const req = createRequire(import.meta.url);
                        const fs = req('node:fs');
                        fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[auto-recap] FAILED: ${String(err)}\n`);
                    }
                    catch { /* never break */ }
                }
                finalize(undefined);
            });
        }
        else {
            finalize(undefined);
        }
    }
    /** Manual trigger (slash command hook). */
    printNow(sessionId = 'unknown') {
        const session = { id: sessionId };
        this.maybePrint(session, 'manual', true);
    }
    detectHost() {
        if (process.env.DSH_DESKTOP === '1' || process.env.ELECTRON_RUN_URL)
            return 'dsh-desktop';
        if (process.env.TERM_PROGRAM || process.env.TTY)
            return 'dsh-tui';
        return 'dsh';
    }
    dispose() {
        for (const off of this.disposers) {
            try {
                off();
            }
            catch {
                /* dispose must never throw */
            }
        }
        this.disposers = [];
        this.recapWrap?.dispose();
        this.recapWrap = null;
        this.acc.clear();
    }
}
