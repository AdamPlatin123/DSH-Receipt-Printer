/**
 * Spawn the bundled Python bridge (vendor/thermal_bridge.py), pipe the stats
 * JSON into stdin, and surface a structured ok/error result.
 *
 * The Python side owns ESC/POS rendering and the Win32 spooler raw-print -
 * this TS side has zero printer knowledge (SRP). Python was chosen because
 * ctypes.windll gives direct winspool.drv access with no native npm module;
 * the same bridge runs standalone for headless testing.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Config } from './index.js'
import type { ReceiptStats } from './collector.js'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url))) // lib/ -> package root

export interface BridgeResult {
  ok: boolean
  /** stdout tail from the bridge (diagnostics) */
  stdout: string
  /** stderr from the bridge: carries the dry-run ASCII preview when enabled */
  stderr?: string
  error?: string
}

export function resolveBridgePath(config: Config): string {
  return config.bridgePath || join(PKG_ROOT, 'vendor', 'thermal_bridge.py')
}

export async function runPythonBridge(config: Config, stats: ReceiptStats): Promise<BridgeResult> {
  const bridgePath = resolveBridgePath(config)
  const args = [bridgePath, '--printer', config.printerName]
  if (config.debug) args.push('--debug')
  if (config.dryRun) args.push('--dry-run')

  return await new Promise<BridgeResult>(resolve => {
    let child
    try {
      child = spawn(config.pythonCmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, stdout: '', error: `spawn failed: ${String(err)}` })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 8192) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 8192) stderr += d.toString('utf8')
    })
    child.on('error', err => {
      resolve({ ok: false, stdout, error: `python not reachable: ${String(err)}` })
    })
    child.on('close', code => {
      if (code === 0) resolve({ ok: true, stdout, stderr })
      else resolve({ ok: false, stdout, stderr, error: `bridge exit=${code}: ${stderr.trim() || '(no stderr)'}` })
    })

    // Feed the payload and signal EOF
    child.stdin?.write(JSON.stringify(stats))
    child.stdin?.end()
    // Safety timeout: never leave a stuck python blocking the host
    const timer = setTimeout(() => {
      child.kill()
    }, 30_000)
    child.on('close', () => clearTimeout(timer))
  })
}
