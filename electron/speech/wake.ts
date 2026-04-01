import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { detectCapabilities, getSpawnEnv } from './detect'

export interface WakeEvent {
  trigger: string
  text: string
  fullText: string
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchTrigger(text: string, triggers: string[]): string | null {
  const lower = text.toLowerCase()
  for (const t of triggers) {
    const re = new RegExp(`(^|\\s|[.,!?;:])${escapeRegex(t)}($|\\s|[.,!?;:])`, 'i')
    if (re.test(lower)) return t
  }
  return null
}

function extractAfter(text: string, trigger: string): string {
  const idx = text.toLowerCase().indexOf(trigger.toLowerCase())
  if (idx < 0) return ''
  return text.slice(idx + trigger.length).replace(/^[,.\s]+/, '').trim()
}

export class WakeDetector extends EventEmitter {
  private proc: ChildProcess | null = null
  private triggers: string[] = []
  private cooldownUntil = 0
  private static COOLDOWN_MS = 3000

  start(triggers: string[], threads = 4): boolean {
    const caps = detectCapabilities()
    if (!caps.streamBinary || !caps.modelPath) {
      console.error('[speech:wake] Cannot start — stream binary:', caps.streamBinary, 'model:', caps.modelPath)
      return false
    }
    this.stop()
    this.triggers = triggers.map(t => t.toLowerCase())

    const args = [
      '-m', caps.modelPath,
      '--step', '3000',
      '--length', '5000',
      '-t', String(threads),
      '--keep-context',
    ]

    this.proc = spawn(caps.streamBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: getSpawnEnv() })
    let buf = ''

    this.proc.stdout?.on('data', (data: Buffer) => {
      buf += data.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const text = line.replace(/\[.*?\]/g, '').trim()
        if (!text || Date.now() < this.cooldownUntil) continue
        const hit = matchTrigger(text, this.triggers)
        if (hit) {
          this.cooldownUntil = Date.now() + WakeDetector.COOLDOWN_MS
          const ev: WakeEvent = { trigger: hit, text: extractAfter(text, hit), fullText: text }
          this.emit('wake', ev)
        }
      }
    })

    this.proc.on('close', (code) => {
      console.warn('[speech:wake] Stream process exited with code', code)
      this.proc = null
      this.emit('stopped')
    })
    this.proc.on('error', (e) => {
      console.error('[speech:wake] Stream process error:', e.message)
      this.proc = null
      this.emit('error', e)
    })
    return true
  }

  stop(): void {
    if (this.proc) { this.proc.kill('SIGTERM'); this.proc = null }
  }

  isRunning(): boolean { return this.proc !== null }

  updateTriggers(triggers: string[]): void {
    this.triggers = triggers.map(t => t.toLowerCase())
  }
}
