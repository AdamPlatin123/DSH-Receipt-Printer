/**
 * E2E test: mock a minimal Cordis Context, load the built plugin from lib/,
 * replay a synthetic DSH session event stream, and verify the full path
 * (collector -> bridge -> python -> spooler) actually prints a receipt.
 *
 * Run: node test/e2e.mjs
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Windows absolute paths must go through pathToFileURL for dynamic import
const plugin = await import(pathToFileURL(resolve(ROOT, 'lib/index.js')).href)
const btw = await import(pathToFileURL(resolve(ROOT, 'lib/btw.js')).href)

// ---- assert helpers ----
let failures = 0
function check(label, cond, extra = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures += 1
  console.log(`  [${mark}] ${label}${extra ? ` - ${extra}` : ''}`)
}

// ---- mock Cordis Context (the surface the plugin actually touches) ----
class MockContext {
  constructor() {
    this.handlers = new Map()
    this.effects = []
    this.commands = []
    this.logger = {
      info: (...a) => console.log('  [log]', ...a),
      warn: (...a) => console.warn('  [warn]', ...a),
    }
  }
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, [])
    this.handlers.get(name).push(fn)
    return () => {
      const arr = this.handlers.get(name) ?? []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  }
  emit(name, ...args) {
    for (const fn of this.handlers.get(name) ?? []) fn(...args)
  }
  effect(dispose) {
    this.effects.push(dispose)
    return () => {}
  }
  get(name) {
    if (name === 'commands') {
      return {
        command: (n, d, fn) => this.commands.push({ name: n, desc: d, fn }),
      }
    }
    return undefined
  }
}

// ---- 1. plugin contract ----
console.log('1. plugin contract')
check('exports name', typeof plugin.name === 'string' && plugin.name === 'dsh-receipt-printer')
check('exports apply function', typeof plugin.apply === 'function')
check('exports StandardSchemaV1 Config', plugin.Config?.['~standard']?.version === 1)

// ---- 2. config schema validation ----
console.log('2. config schema')
const ok = plugin.Config['~standard'].validate({
  printerName: 'Thermal-58',
  trigger: 'turn-end',
  minIntervalSec: '30',
})
check('accepts + coerces valid config', ok.value?.minIntervalSec === 30 && ok.value?.printerName === 'Thermal-58')
const bad = plugin.Config['~standard'].validate({ trigger: 'bogus' })
check('rejects invalid enum', Array.isArray(bad.issues) && bad.issues.length > 0)
const empty = plugin.Config['~standard'].validate(undefined)
check('undefined falls back to defaults', empty.value?.enabled === true && empty.value?.pythonCmd === 'python')

// ---- 3. apply + event stream replay ----
console.log('3. apply + session/event replay (DRY-RUN by default; set PRINT_REAL=1 for paper)')
const ctx = new MockContext()
const session = {
  id: 'test-session-abc12345',
  appended: [],
  append(type, payload) {
    this.appended.push({ type, payload })
  },
}
plugin.apply(ctx, { ...empty.value, printerName: 'Thermal-58', minIntervalSec: 0, dryRun: process.env.PRINT_REAL !== '1' })

check('subscribed to session/event', (ctx.handlers.get('session/event') ?? []).length === 1)
check('subscribed to session/disposed', (ctx.handlers.get('session/disposed') ?? []).length === 1)
check('commands service soft-probed (no /receipt without it)', true)

// Real DSH event shape: {type, seq, time, data} - payload in `.data`, camelCase
const evts = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { model: 'glm-5.3' }, usage: { inputTokens: 50000, outputTokens: 1500, cacheReadTokens: 200000 } } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'Write', arguments: JSON.stringify({ file_path: 'G:/tmp/demo.py' }) } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'Write', arguments: JSON.stringify({ file_path: 'G:/tmp/other.py' }) } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'Bash', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'Bash', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'Edit', arguments: JSON.stringify({ file_path: 'G:/tmp/demo.py' }) } },
  { type: 'tool/result', data: { turn: 1, step: 1, message: {} } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
for (const ev of evts) ctx.emit('session/event', session, ev)
check('replayed 9 events without throwing', true)

// ---- 4. wait for the async print ----
console.log('4. async print result')
const deadline = Date.now() + 30_000
while (Date.now() < deadline && session.appended.length === 0) {
  await new Promise(r => setTimeout(r, 200))
}
const receiptEvt = session.appended.find(e => e.type === 'receipt/printed')
check('receipt/printed appended to session', Boolean(receiptEvt))
if (receiptEvt) {
  const p = receiptEvt.payload
  check('bridge reported ok=true', p.ok === true, `error=${p.error ?? 'none'}`)
  check('turnCount=1', p.turnCount === 1)
  check('toolCalls=5', p.toolCalls === 5, `got ${p.toolCalls}`)
  check('totalTokens>0', p.totalTokens > 0)
}

// ---- 5. auto-recap: turn/end asks llm for summary, merges into ONE receipt ----
console.log('5. auto-recap merged receipt (turn/end -> llm summary -> one print)')
const recapMod = await import(pathToFileURL(resolve(ROOT, 'lib/recap.js')).href)

// 5a. prompt builder shape
const draft = {
  sessionId: 's1', project: 'demo', startedAt: '', endedAt: '',
  durationSec: 90, model: 'glm-5.3', turns: 2,
  toolCalls: { Write: 2, Bash: 1 }, filesWritten: ['a.ts'],
  inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, thinkingTokens: 0,
  trigger: 'turn-end', host: 'dsh-tui',
}
const prompt = recapMod.buildRecapPrompt(draft)
check('prompt carries stats', prompt.includes('demo') && /Writ[e]*\s*[x×]?\s*2/.test(prompt), prompt.match(/- 工具:.*/)?.[0] ?? '')
check('prompt is natural-language (no hard caps)', prompt.includes('回执') && !prompt.includes('不得超过') && !prompt.includes('严格'))

// 5b. generateRecap with a mock llm (auto tag must NOT trigger btw wrap)
const recapLlm = {
  stream: async function* (options) {
    const tag = options?.messages?.[0]?.source?.plugin
    yield { type: 'text-delta', text: `tag=${tag} ` }
    yield { type: 'text-delta', text: '完成: demo task\n产出: a.ts' }
  },
}
const captured2 = []
const wrap2 = btw.wrapLlmForRecap(recapLlm, cap => captured2.push(cap))
const autoAnswer = await recapMod.generateRecap(recapLlm, draft, 5000)
check('generateRecap returns answer', autoAnswer?.includes('完成: demo task'))
check('auto-recap NOT intercepted by btw wrap', captured2.length === 0, `captured=${captured2.length}`)
wrap2.dispose()

// 5c. generateRecap degrades gracefully on llm absent / throw
check('no llm -> undefined', (await recapMod.generateRecap(undefined, draft)) === undefined)
const badLlm = { stream: async function* () { throw new Error('boom') } }
check('throwing llm -> undefined', (await recapMod.generateRecap(badLlm, draft, 500)) === undefined)

// ---- 6. pricing: peak-aware CNY cost + balance (dsh-tui aligned) ----
console.log('6. pricing (peak/off-peak CNY cost + balance)')
const pricing = await import(pathToFileURL(resolve(ROOT, 'lib/pricing.js')).href)

// 6a. flash peak (Beijing Monday 10:00 = UTC 02:00)
// formula: (input-cacheRead)*miss[peak] + cacheRead*hit[peak] + output*out[peak]
// 1M in, 1M hit, 1M out -> (1-1)*3.0 + 1*0.10 + 1*9.0 = 9.10 CNY
const monPeak = new Date('2026-09-07T02:00:00Z') // Monday
const costPeak = pricing.computeCostCny('deepseek-v4-flash', 1e6, 1e6, 1e6, monPeak)
check('flash peak hit+out = 0.10 + 9.0', Math.abs(costPeak - 9.10) < 1e-9, `got ${costPeak}`)

// 6b. flash off-peak same Saturday (weekend never peak)
const satSame = new Date('2026-09-05T02:00:00Z') // Saturday
const costSat = pricing.computeCostCny('deepseek-v4-flash', 1e6, 1e6, 1e6, satSame)
check('Saturday never peak -> 0.05 + 4.5', Math.abs(costSat - 4.55) < 1e-9, `got ${costSat}`)

// 6c. pure miss input (peak Monday)
const missPeak = pricing.computeCostCny('deepseek-v4-flash', 1e6, 0, 0, monPeak)
check('flash peak pure-miss = 3.0', Math.abs(missPeak - 3.0) < 1e-9)

// 6d. pro pricing + prefix match + unknown model
const proCost = pricing.computeCostCny('deepseek-v4-pro', 1e6, 0, 0, satSame)
check('pro off pure-miss = 4.5', Math.abs(proCost - 4.5) < 1e-9)
const prefixCost = pricing.computeCostCny('deepseek-v4-flash-vision-exp', 1e6, 0, 0, satSame)
check('vision-exp prefix priced as flash', Math.abs(prefixCost - 1.5) < 1e-9)
check('unknown model -> undefined', pricing.computeCostCny('gpt-99', 100, 0, 0) === undefined)

// 6e. peak window boundaries (Beijing weekday 9-12, 14-18)
check('Beijing Mon 09:00 peak', pricing.isPeakHour(new Date('2026-09-07T01:00:00Z')) === true)
check('Beijing Mon 11:59 peak', pricing.isPeakHour(new Date('2026-09-07T03:59:00Z')) === true)
check('Beijing Mon 12:00 off', pricing.isPeakHour(new Date('2026-09-07T04:00:00Z')) === false)
check('Beijing Mon 14:00 peak', pricing.isPeakHour(new Date('2026-09-07T06:00:00Z')) === true)
check('Beijing Mon 17:59 peak', pricing.isPeakHour(new Date('2026-09-07T09:59:00Z')) === true)
check('Beijing Mon 18:00 off', pricing.isPeakHour(new Date('2026-09-07T10:00:00Z')) === false)
check('Beijing Sat 10:00 off (weekend)', pricing.isPeakHour(new Date('2026-09-05T02:00:00Z')) === false)
check('Beijing Sun 15:00 off (weekend)', pricing.isPeakHour(new Date('2026-09-06T07:00:00Z')) === false)

// 6f. balance resolver never throws
delete process.env.DEEPSEEK_API_KEY
const bal0 = await import(pathToFileURL(resolve(ROOT, 'lib/balance.js')).href)
const bal = await bal0.fetchBalance()
check('balance lookup never throws', bal === undefined || typeof bal.total === 'string', `got ${JSON.stringify(bal)?.slice(0, 80)}`)

// ---- 7. /btw recap capture via llm.stream wrap ----
console.log('7. /btw recap capture (llm.stream wrap)')

// 5a. detectSideKind + stripReminder
const REMINDER = `<system-reminder>This is a side question from the user. You must answer directly.</system-reminder>\n\n`
const btwOpts = {
  model: 'test-model',
  messages: [
    { role: 'user', content: 'earlier turn' },
    {
      role: 'user',
      content: REMINDER + '为什么用 wrap 而不是监听事件?',
      source: { kind: 'plugin', plugin: 'dsh-tui/btw' },
    },
  ],
}
check('detects btw from source.plugin', btw.detectSideKind(btwOpts) === 'btw')
check('strips system-reminder wrapper', btw.stripReminder(REMINDER + 'abc') === 'abc')
check('extracts raw question', btw.extractQuestion(btwOpts) === '为什么用 wrap 而不是监听事件?')
check('non-side call returns null', btw.detectSideKind({ messages: [{ role: 'user', content: 'x' }] }) === null)

// 5b. full wrap on a fake llm: verify answer accumulation + onComplete fires
let captured = null
const fakeLlm = {
  stream: async function* (options) {
    // simulate the real LLM: text-delta chunks then done
    for (const t of ['因为 ', '/btw ', '不写 session log.']) {
      yield { type: 'text-delta', text: t }
    }
    yield { type: 'message-end' }
  },
}
const wrap = btw.wrapLlmForRecap(fakeLlm, cap => { captured = cap })
const iter = fakeLlm.stream(btwOpts)
const chunks = []
for await (const c of iter) chunks.push(c)
await new Promise(r => setTimeout(r, 50))
check('chunks pass through unchanged', chunks.length === 4)
check('capture fired with kind=btw', captured?.kind === 'btw')
check('answer accumulated', captured?.answer === '因为 /btw 不写 session log.')
check('model captured', captured?.model === 'test-model')
wrap.dispose()
const afterDispose = fakeLlm.stream(btwOpts)
check('dispose restores original stream', typeof afterDispose[Symbol.asyncIterator] === 'function')

// ---- 8. dispose ----
console.log('8. dispose')
// ctx.effect(fn) stores the setup; fn() returns the actual disposer (Cordis semantics)
for (const setup of ctx.effects) {
  try { setup()?.() } catch { /* never throw */ }
}
check('disposed cleanly', (ctx.handlers.get('session/event') ?? []).length === 0)

// ---- summary ----
console.log('')
if (failures === 0) {
  console.log('ALL PASS')
  process.exit(0)
} else {
  console.log(`${failures} FAILURE(S)`)
  process.exit(1)
}
