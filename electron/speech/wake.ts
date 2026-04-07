import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { detectCapabilities, getSpawnEnv } from './detect'
import { createLogger } from '../logger'

const log = createLogger('speech:wake')

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
      log.error('Cannot start wake detector — missing dependencies', { streamBinary: caps.streamBinary, modelPath: caps.modelPath })
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

    log.info('Starting wake detector', { binary: caps.streamBinary, triggers: this.triggers, threads, model: caps.modelPath })
    log.debug('Stream args', args.join(' '))

    this.proc = spawn(caps.streamBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: getSpawnEnv() })
    const pid = this.proc.pid
    log.info('Wake stream process spawned', { pid })

    let buf = ''
    let stderrBuf = ''

    this.proc.stdout?.on('data', (data: Buffer) => {
      buf += data.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const text = line.replace(/\[.*?\]/g, '').trim()
        if (!text) continue
        if (Date.now() < this.cooldownUntil) {
          log.debug('Wake text ignored (cooldown)', { text })
          continue
        }
        log.debug('Wake stream text', { text })
        const hit = matchTrigger(text, this.triggers)
        if (hit) {
          this.cooldownUntil = Date.now() + WakeDetector.COOLDOWN_MS
          const ev: WakeEvent = { trigger: hit, text: extractAfter(text, hit), fullText: text }
          log.info('Wake trigger MATCHED', ev)
          this.emit('wake', ev)
        }
      }
    })

    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd()
      if (text) {
        stderrBuf += text + '\n'
        log.debug(`[wake:stderr pid=${pid}] ${text}`)
      }
    })

    this.proc.on('close', (code, signal) => {
      log.warn('Wake stream process exited', { pid, code, signal, stderrLen: stderrBuf.length })
      if (stderrBuf.trim()) log.debug('Wake stream stderr at exit', stderrBuf.trim().slice(0, 500))
      this.proc = null
      this.emit('stopped')
    })
    this.proc.on('error', (e) => {
      log.error('Wake stream process error', { pid, error: e.message, stack: e.stack })
      this.proc = null
      this.emit('error', e)
    })
    return true
  }

  stop(): void {
    if (this.proc) {
      log.info('Stopping wake detector', { pid: this.proc.pid })
      this.proc.kill('SIGTERM')
      this.proc = null
    }
  }

  isRunning(): boolean { return this.proc !== null }

  updateTriggers(triggers: string[]): void {
    this.triggers = triggers.map(t => t.toLowerCase())
    log.info('Wake triggers updated', { triggers: this.triggers })
  }
}
