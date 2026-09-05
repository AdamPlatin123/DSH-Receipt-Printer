// Reproduce the exact bridge.ts spawn path (utf8 stdin) and verify the
// Python side now decodes the recap answer correctly.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const stats = {
  sessionId: 'encoding-fix-test',
  project: 'thermal-printer',
  durationSec: 95, model: 'glm-5.3', turns: 2,
  toolCalls: { Edit: 5, Bash: 3 },
  filesWritten: ['collector.ts', 'recap.ts'],
  inputTokens: 50000, outputTokens: 3000, cacheReadTokens: 200000, thinkingTokens: 0,
  trigger: 'turn-end', host: 'dsh-tui',
  recap: {
    kind: 'auto', question: '',
    answer: '完成: 修复了 recap 中文乱码问题\n产出: collector.ts, recap.ts\n下一步: 在真机小票上验证',
    model: 'glm-5.3',
  },
}

const child = spawn('python', [resolve('vendor/thermal_bridge.py'), '--printer', 'Thermal-58', '--dry-run'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
let stdout = '', stderr = ''
child.stdout.on('data', d => { stdout += d.toString('utf8') })
child.stderr.on('data', d => { stderr += d.toString('utf8') })
child.on('close', code => {
  console.log('exit:', code)
  console.log('stdout:', stdout.trim())
  const ok = /RECAP/.test(stderr) && stderr.includes('完成:') && stderr.includes('下一步:')
  console.log('recap renders correctly in stderr preview:', ok)
  console.log('--- preview tail ---')
  console.log(stderr.split('RECAP')[1]?.slice(0, 300) ?? '(no RECAP section)')
  process.exit(ok ? 0 : 1)
})
child.stdin.write(JSON.stringify(stats))
child.stdin.end()
