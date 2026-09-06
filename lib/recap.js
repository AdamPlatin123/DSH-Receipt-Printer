/**
 * Auto-recap: on turn/session end the plugin itself asks the LLM for a short
 * printable summary of the just-finished task, then merges it with the stats
 * into ONE receipt (instead of two separate prints).
 *
 * The call is tool-less, single-turn, and never enters the session log -
 * same semantics as dsh-tui's /btw sideQuestion, but initiated by us with
 * source.plugin = 'dsh-receipt-printer' so our own llm.stream wrap in btw.ts
 * does NOT intercept it (no 'btw'/'recap' keyword in the tag).
 */
import { createRequire } from 'node:module';
/**
 * Natural-language recap prompt: no hard per-line caps or fixed three-section
 * template - just tell the model what a receipt reads like and let it write.
 * The rendering side (wrap_text with max_lines=None + total cap 8 lines)
 * owns the physical constraints, so the prompt stays guidance-only.
 */
export function buildRecapPrompt(stats) {
    const tools = Object.entries(stats.toolCalls)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([n, c]) => `${n}x${c}`)
        .join(', ');
    const files = stats.filesWritten.slice(0, 4).map(fp => String(fp).replace(/\\/g, '/').split('/').pop());
    const lines = [
        `- 项目: ${stats.project}`,
        `- 时长: ${Math.round(stats.durationSec)}s, 轮次: ${stats.turns}`,
        tools ? `- 工具: ${tools}` : '',
        files.length ? `- 文件: ${files.join(', ')}` : '',
    ].filter(Boolean);
    return [
        '你是 58mm 热敏小票的回执打印机. 一轮 agent 任务刚结束,',
        '请用几句自然的中文写下这轮的回执: 做了什么, 产出了什么,',
        '以及接下来值得做什么 (任务已经完整就不用写).',
        '',
        '像口头汇报那样直接说, 不要标题符号、不要 markdown、不要客套.',
        '总共 100 字左右, 几行就够.',
        '',
        '任务统计:',
        ...lines,
    ].join('\n');
}
export async function generateRecap(llm, stats, timeoutMs = 30_000, route) {
    if (!llm || typeof llm.stream !== 'function')
        return undefined;
    // Fallbacks: dsh-base's agent-default-model pins deepseek-official /
    // deepseek-v4-flash when neither the live session header nor the absorbed
    // assistant/message model is available.
    const provider = route?.provider || 'deepseek-official';
    const model = route?.model || stats.model || 'deepseek-v4-flash';
    const options = {
        provider,
        model,
        // 'off' disables the reasoning pass entirely (dsh-llm-deepseek accepts
        // off/low/high/max): the recap is a tiny summary and reasoning-mode
        // models burn tens of thousands of reasoning-delta chunks before any
        // visible text - which alone blew our timeout budget.
        reasoningEffort: 'off',
        messages: [
            {
                role: 'user',
                // DSH message shape (same as dsh-tui's createUserMessage for /btw):
                // content MUST be a ContentBlock array, not a bare string.
                content: [{ type: 'text', text: buildRecapPrompt(stats) }],
                // Deliberately NO 'btw'/'recap' substring: our btw.ts wrap must not
                // intercept our own auto-recap call.
                source: { kind: 'plugin', plugin: 'dsh-receipt-printer' },
            },
        ],
        sessionId: stats.sessionId,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let answer = '';
    const dbg = (msg) => {
        if (process.env.THERMAL_DEBUG !== '1')
            return;
        try {
            const req = createRequire(import.meta.url);
            const fs = req('node:fs');
            fs.appendFileSync(process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`, `[generateRecap] ${msg}\n`);
        }
        catch { /* never break */ }
    };
    try {
        let n = 0;
        const types = new Set();
        let finishPayload = '';
        for await (const chunk of llm.stream({ ...options, signal: ac.signal })) {
            n += 1;
            if (chunk?.type)
                types.add(chunk.type);
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
                if (answer.length < 2048)
                    answer += chunk.text;
            }
            if (chunk?.type === 'finish' || n <= 2) {
                try {
                    finishPayload = JSON.stringify(chunk).slice(0, 300);
                }
                catch {
                    finishPayload = String(chunk);
                }
            }
        }
        dbg(`stream done chunks=${n} types=${[...types].join(',')} textLen=${answer.length} last=${finishPayload}`);
    }
    catch (err) {
        dbg(`stream threw: ${String(err).slice(0, 200)}`);
        return undefined;
    }
    finally {
        clearTimeout(timer);
    }
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
