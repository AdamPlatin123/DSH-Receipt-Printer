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
import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { miniSchema } from './schema.js'
import { ReceiptCollector } from './collector.js'
import { registerReceiptEventTypes } from './registration.js'

export const name = 'dsh-receipt-printer'

export const usage = ` Thermal Receipt - print a 58mm receipt when a DSH turn ends.
Config (cordis.patch.yml row "config"):
  enabled        boolean  default true
  pythonCmd      string   default "python"       Python interpreter with ctypes (Windows)
  printerName    string   default "Thermal-58"   Win32 spooler queue name
  trigger        enum     "turn-end" | "session-end" | "manual"
  minIntervalSec number   default 60             debounce (skip if printed < N sec ago)
  bridgePath     string   default ""             override path to thermal_bridge.py
  debug          boolean  default false          bridge prints diagnostics
`

export interface Config {
  enabled: boolean
  pythonCmd: string
  printerName: string
  trigger: 'turn-end' | 'session-end' | 'manual'
  minIntervalSec: number
  bridgePath: string
  debug: boolean
  /** Print a separate recap receipt for /btw side questions and /recap calls. */
  printSideCalls: boolean
  /** Ask the LLM for a task summary at trigger time; merge into ONE receipt. */
  autoRecap: boolean
  /** Hard cap for the auto-recap LLM call before degrading to stats-only. */
  autoRecapTimeoutSec: number
  /** Render + log the receipt but skip the physical print (testing/CI). */
  dryRun: boolean
}

export const Config = miniSchema<Config>({
  defaults: {
    enabled: true,
    pythonCmd: 'python',
    printerName: 'Thermal-58',
    trigger: 'turn-end',
    minIntervalSec: 60,
    bridgePath: '',
    debug: false,
    printSideCalls: true,
    autoRecap: true,
    autoRecapTimeoutSec: 30,
    dryRun: false,
  },
  enums: {
    trigger: ['turn-end', 'session-end', 'manual'] as const,
  },
  numbers: ['minIntervalSec', 'autoRecapTimeoutSec'],
  booleans: ['enabled', 'debug', 'printSideCalls', 'autoRecap', 'dryRun'],
})

export function apply(ctx: Context, config: Config): void {
  // Debug-only markers (THERMAL_DEBUG=1): file-based because DSH logger output
  // is not always visible on stdout. Diagnostics must never break the plugin.
  if (process.env.THERMAL_DEBUG === '1') {
    try {
      const req = createRequire(import.meta.url)
      const fs = req('node:fs') as typeof import('node:fs')
      const logPath = process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`
      fs.appendFileSync(logPath, `[apply] ts=${new Date().toISOString()} pid=${process.pid} config=${JSON.stringify(config)}\n`)
    } catch { /* never break */ }
  }
  if (!config?.enabled) return
  // Mandatory before any session.append(): unregistered types break resume.
  registerReceiptEventTypes()

  const collector = new ReceiptCollector(ctx, config)

  // Optional manual trigger: if the host mounts a commands service, expose
  // /receipt. Soft-probe (ctx.get('commands', false)) so a host without it
  // degrades silently (#183 principle from the dsh-TUI plugin guide).
  const commands = (ctx as unknown as {
    get?: (name: string, soft?: false) => unknown
  }).get?.('commands', false) as
    | { command?(name: string, desc: string, fn: () => void): void }
    | undefined
  if (commands?.command) {
    commands.command('receipt', 'print a thermal receipt for the current session now', () => {
      collector.printNow()
    })
  }

  ctx.effect(() => () => collector.dispose())
}

// Re-export for consumers (the dsh-TUI ecosystem convention of explicit
// subpath re-exports also works through this entry).
export { ReceiptCollector } from './collector.js'
export type { ReceiptStats } from './collector.js'
export { RECEIPT_EVENT_TYPE, type ReceiptPrintedPayload } from './events.js'
export { runPythonBridge, resolveBridgePath, type BridgeResult } from './bridge.js'
