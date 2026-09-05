/**
 * DeepSeek 官方定价与本会话花费估算（人民币口径）。
 *
 * 价格表来源：DeepSeek 官方文档「模型 & 价格」页（2026-08 快照，对齐
 * dsh-tui 的 deepseekPricing.js 方案）。单位：元 / 1M tokens。
 * 每档价格是 [谷, 峰] 二元组（空闲价为高峰价的一半）。
 *
 * 计价规则（官方页面）：
 *  - 扣减费用 = token 消耗量 × 模型单价
 *  - 缓存命中的输入按命中价计费，其余输入（含写入缓存）按未命中价计费
 *  - 高峰 = 北京时间**周一至周五** 9:00-12:00、14:00-18:00；
 *    其余时段（含全部周末）为空闲
 *
 * 这是**估算**，不是账单 —— 定价可能变动，以 DeepSeek 平台账单为准。
 */
/** 在售模型价目表，按 API model id 前缀匹配（最长前缀优先）。 */
export const DEEPSEEK_MODEL_PRICES = {
    'deepseek-v4-flash': {
        inputMiss: [1.5, 3.0],
        inputHit: [0.05, 0.10],
        output: [4.5, 9.0],
    },
    'deepseek-v4-pro': {
        inputMiss: [4.5, 9.0],
        inputHit: [0.15, 0.30],
        output: [13.5, 27.0],
    },
    'deepseek-v4-flash-vision-exp': {
        inputMiss: [1.5, 3.0],
        inputHit: [0.05, 0.10],
        output: [4.5, 9.0],
    },
};
/** DeepSeek 官方 API key 路由（定价只对官方计费口径有意义）。 */
export const DEEPSEEK_OFFICIAL_PROVIDERS = ['deepseek', 'deepseek-official', 'deepseek-vision'];
/** 是否 DeepSeek 官方 provider。 */
export function isDeepSeekOfficialProvider(provider) {
    return DEEPSEEK_OFFICIAL_PROVIDERS.includes(provider);
}
/**
 * 是否处于高峰计费时段：北京时间周一至周五 9:00-12:00、14:00-18:00。
 * 北京时间为 UTC+8 固定偏移（无夏令时），用 UTC 时刻加偏移换算。
 */
export function isPeakHour(date = new Date()) {
    const shifted = new Date(date.getTime() + 8 * 3_600_000);
    const weekday = shifted.getUTCDay(); // 0 = Sunday
    if (weekday === 0 || weekday === 6)
        return false;
    const hour = shifted.getUTCHours();
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}
/** 按前缀匹配模型价目，最长前缀优先；未收录返回 undefined。 */
export function priceForModel(model) {
    let best;
    let bestLength = 0;
    for (const [prefix, price] of Object.entries(DEEPSEEK_MODEL_PRICES)) {
        if (model.startsWith(prefix) && prefix.length > bestLength) {
            best = price;
            bestLength = prefix.length;
        }
    }
    return best;
}
/**
 * 估算一段用量的花费（人民币元）。
 * 公式：(input − cacheRead) × miss + cacheRead × hit + output × out。
 * cacheWrite 不单独计价（写入缓存的 token 已计入 input 的未命中部分）。
 * 模型未收录返回 undefined（界面不显示金额，不给错误数字）。
 */
export function computeCostCny(model, inputTokens, cacheReadTokens, outputTokens, at = new Date()) {
    const price = priceForModel(model);
    if (price === undefined)
        return undefined;
    const rateIndex = isPeakHour(at) ? 1 : 0;
    const input = Math.max(0, inputTokens);
    const output = Math.max(0, outputTokens);
    const cacheRead = Math.max(0, Math.min(input, cacheReadTokens));
    return ((input - cacheRead) * price.inputMiss[rateIndex] +
        cacheRead * price.inputHit[rateIndex] +
        output * price.output[rateIndex]) / 1e6;
}
/** Receipt line format: "¥0.0056"（4dp，turn 成本常为厘级）. */
export function formatCny(cost) {
    return `¥${cost.toFixed(4)}`;
}
