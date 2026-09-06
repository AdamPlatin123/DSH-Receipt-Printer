import { createRequire } from 'node:module';
import { miniSchema } from './schema.js';
import { ReceiptCollector } from './collector.js';
import { registerReceiptEventTypes } from './registration.js';
export const name = 'dsh-receipt-printer';
export const usage = ` Thermal Receipt - print a 58mm receipt when a DSH turn ends.
Config (cordis.patch.yml row "config"):
  enabled        boolean  default true
  pythonCmd      string   default "python"       Python interpreter with ctypes (Windows)
  printerName    string   default "Thermal-58"   Win32 spooler queue name
  trigger        enum     "turn-end" | "session-end" | "manual"
  minIntervalSec number   default 60             debounce (skip if printed < N sec ago)
  bridgePath     string   default ""             override path to thermal_bridge.py
  debug          boolean  default false          bridge prints diagnostics
`;
export const Config = miniSchema({
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
        trigger: ['turn-end', 'session-end', 'manual'],
    },
    numbers: ['minIntervalSec', 'autoRecapTimeoutSec'],
    booleans: ['enabled', 'debug', 'printSideCalls', 'autoRecap', 'dryRun'],
});
export function apply(ctx, config) {
    // Debug-only markers (THERMAL_DEBUG=1): file-based because DSH logger output
    // is not always visible on stdout. Diagnostics must never break the plugin.
    if (process.env.THERMAL_DEBUG === '1') {
        try {
            const req = createRequire(import.meta.url);
            const fs = req('node:fs');
            const logPath = process.env.THERMAL_DEBUG_LOG || `${process.cwd()}/.thermal-debug.log`;
            fs.appendFileSync(logPath, `[apply] ts=${new Date().toISOString()} pid=${process.pid} config=${JSON.stringify(config)}\n`);
        }
        catch { /* never break */ }
    }
    if (!config?.enabled)
        return;
    // Mandatory before any session.append(): unregistered types break resume.
    registerReceiptEventTypes();
    const collector = new ReceiptCollector(ctx, config);
    // Optional manual trigger: if the host mounts a commands service, expose
    // /receipt. Soft-probe (ctx.get('commands', false)) so a host without it
    // degrades silently (#183 principle from the dsh-TUI plugin guide).
    const commands = ctx.get?.('commands', false);
    if (commands?.command) {
        commands.command('receipt', 'print a thermal receipt for the current session now', () => {
            collector.printNow();
        });
    }
    ctx.effect(() => () => collector.dispose());
}
// Re-export for consumers (the dsh-TUI ecosystem convention of explicit
// subpath re-exports also works through this entry).
export { ReceiptCollector } from './collector.js';
export { RECEIPT_EVENT_TYPE } from './events.js';
export { runPythonBridge, resolveBridgePath } from './bridge.js';
