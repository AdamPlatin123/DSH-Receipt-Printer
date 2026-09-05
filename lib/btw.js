/** Strip the `<system-reminder>...</system-reminder>\n\n` wrapper dsh-tui adds. */
export function stripReminder(wrapped) {
    const m = wrapped.match(/<\/system-reminder>\s*\n*\s*([\s\S]+)$/);
    return (m ? m[1] : wrapped).trim();
}
/** Detect what kind of side call this is from the last user message's source tag. */
export function detectSideKind(options) {
    const msgs = options?.messages;
    if (!Array.isArray(msgs) || msgs.length === 0)
        return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.role !== 'user')
            continue;
        const plugin = m.source?.plugin ?? '';
        if (plugin.includes('btw'))
            return 'btw';
        if (plugin.includes('recap'))
            return 'recap';
        return null; // last user message is not a side call
    }
    return null;
}
/** Pull the question text out of the last user message (handles string + block array). */
export function extractQuestion(options) {
    const msgs = options?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.role !== 'user')
            continue;
        if (typeof m.content === 'string')
            return stripReminder(m.content);
        if (Array.isArray(m.content)) {
            const text = m.content.find(b => b?.type === 'text' && typeof b.text === 'string');
            if (text)
                return stripReminder(text.text);
        }
        return '';
    }
    return '';
}
/**
 * Monkey-patch `llm.stream` to observe side calls. Returns a disposer that
 * restores the original method. Never throws on malformed input.
 */
export function wrapLlmForRecap(llm, onComplete) {
    const original = llm.stream.bind(llm);
    llm.stream = (options) => {
        const kind = detectSideKind(options);
        if (!kind)
            return original(options);
        const question = extractQuestion(options);
        const model = String(options?.model ?? '');
        let answer = '';
        const self = {
            [Symbol.asyncIterator]() {
                const inner = original(options)[Symbol.asyncIterator]();
                return {
                    async next() {
                        const r = await inner.next();
                        if (!r.done) {
                            const c = r.value;
                            if (c && c.type === 'text-delta' && typeof c.text === 'string') {
                                if (answer.length < 4096)
                                    answer += c.text;
                            }
                        }
                        else {
                            // stream finished - emit the capture (never let it throw)
                            try {
                                onComplete({ kind, question, answer: answer.trim(), model });
                            }
                            catch { /* observer must never break the host */ }
                        }
                        return r;
                    },
                    async return(value) {
                        try {
                            const r = await inner.return?.(value);
                            if (r)
                                return r;
                        }
                        catch { /* ignore */ }
                        return { done: true, value: undefined };
                    },
                    async throw(err) {
                        try {
                            const r = await inner.throw?.(err);
                            if (r)
                                return r;
                        }
                        catch { /* ignore */ }
                        return { done: true, value: undefined };
                    },
                };
            },
        };
        return self;
    };
    return {
        dispose() {
            try {
                llm.stream = original;
            }
            catch { /* ignore */ }
        },
    };
}
/** Attach a recap capture to the recap field on ReceiptStats. */
export function withRecap(stats, capture) {
    return {
        ...stats,
        turns: 0,
        trigger: capture.kind,
        recap: {
            kind: capture.kind,
            question: capture.question.slice(0, 200),
            answer: capture.answer.slice(0, 400),
            model: capture.model,
        },
    };
}
