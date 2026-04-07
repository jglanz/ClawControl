/**
 * Unified streaming speech manager using a single persistent whisper-stream process.
 *
 * Architecture (mirrors macOS/iOS native apps):
 * - One whisper-stream process runs the entire time the app is active
 * - It captures audio via SDL2 and outputs transcribed text to stdout in real-time
 * - We parse stdout and switch between states:
 *   WAKE:      Match trigger words, extract post-trigger command
 *   CAPTURING: Accumulate text until silence, emit final transcript
 *   IDLE:      Stream running but not processing (e.g., during TTS playback)
 *
 * This eliminates per-request process spawning latency entirely.
 */

import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { detectCapabilities, getSpawnEnv } from './detect'
import { createLogger } from '../logger'

const log = createLogger('speech:stream')

export type StreamState = 'off' | 'wake' | 'capturing' | 'idle'

export interface WakeMatchEvent {
  trigger: string
  command: string
  fullText: string
}

const VA_ACTIVATE_COMMANDS = [
  'start voice assistant', 'start assistant', 'voice mode',
  'start talking', 'voice assistant', 'start voice',
]

const STOP_COMMANDS = ['stop assistant', 'stop voice', 'stop listening']

// ANSI escape sequences: CSI codes, OSC, cursor movement, etc.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g

// Whisper hallucinates these during silence/background noise
const HALLUCINATION_PHRASES = [
  'thank you', 'thanks for watching', 'subscribe', 'you', 'yeah',
  'yes', 'no', 'okay', 'ok', 'bye', 'goodbye', 'hmm', 'uh', 'um',
  'oh', 'ah', 'so', 'well', 'right', 'the end', 'thanks',
  'please subscribe', 'like and subscribe', 'see you next time',
  'i\'ll see you in the next video', 'subtitles by',
]
const HALLUCINATION_RE = new RegExp(
  `^\\s*(${HALLUCINATION_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[.!?,\\s]*$`,
  'i',
)

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
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

function isVACommand(text: string): boolean {
  const lower = text.toLowerCase().trim()
  return VA_ACTIVATE_COMMANDS.some(cmd => lower.includes(cmd))
}

function isStopCommand(text: string, triggers: string[]): boolean {
  const lower = text.toLowerCase().trim()
  if (STOP_COMMANDS.some(c => lower.includes(c))) return true
  return triggers.some(t => lower.includes(`stop ${t.toLowerCase()}`))
}

/**
 * Events emitted:
 * - 'wake'          (WakeMatchEvent) — trigger word matched in wake state
 * - 'vaActivate'    () — "start voice assistant" command detected
 * - 'transcript'    (text: string) — final transcript from capturing state (silence detected)
 * - 'partial'       (text: string) — live partial transcript during capturing
 * - 'stopCommand'   () — user said "stop assistant" etc. during capturing
 * - 'started'       () — stream process launched
 * - 'stopped'       () — stream process exited
 * - 'error'         (Error) — stream error
 */
export class WhisperStreamManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private _state: StreamState = 'off'
  private triggers: string[] = []
  private silenceWindowMs = 1500
  private captureBuffer = ''
  private lastTextTime = 0
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private cooldownUntil = 0
  private static WAKE_COOLDOWN_MS = 3000
  // Track text segments seen recently to avoid duplicates (across all states)
  private captureSegmentsSeen = new Set<string>()
  private recentSegments: { text: string; time: number }[] = []
  private static DEDUP_WINDOW_MS = 15000

  get state(): StreamState { return this._state }

  /** Start the persistent whisper-stream process. */
  start(): boolean {
    if (this.proc) {
      log.debug('Stream already running')
      return true
    }

    const caps = detectCapabilities()
    if (!caps.streamBinary || !caps.modelPath) {
      log.error('Cannot start stream — missing dependencies', {
        streamBinary: caps.streamBinary,
        modelPath: caps.modelPath,
      })
      return false
    }

    const args = [
      '-m', caps.modelPath,
      '--step', '4000',
      '--length', '10000',
      '-t', '8',
      '--max-tokens', '128',
      '-l', 'en',
      '--flash-attn',
      '--vad-thold', '0.8',
    ]

    log.info('Starting whisper-stream process', {
      binary: caps.streamBinary,
      model: caps.modelPath,
      args: args.join(' '),
    })

    this.proc = spawn(caps.streamBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getSpawnEnv(),
    })

    const pid = this.proc.pid
    log.info('Stream process spawned', { pid })

    let stdoutBuf = ''

    this.proc.stdout?.on('data', (data: Buffer) => {
      stdoutBuf += data.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() || ''
      for (const line of lines) {
        this.handleLine(line)
      }
    })

    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd()
      if (text) log.debug(`[stream:stderr pid=${pid}] ${text}`)
    })

    this.proc.on('close', (code, signal) => {
      log.warn('Stream process exited', { pid, code, signal })
      this.proc = null
      this.stopSilenceMonitor()
      this._state = 'off'
      this.emit('stopped')
    })

    this.proc.on('error', (err) => {
      log.error('Stream process error', { pid, error: err.message })
      this.proc = null
      this._state = 'off'
      this.emit('error', err)
    })

    this._state = 'idle'
    this.emit('started')
    return true
  }

  /** Stop the stream process entirely. */
  stop(): void {
    this.stopSilenceMonitor()
    if (this.proc) {
      log.info('Stopping stream process', { pid: this.proc.pid })
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    this._state = 'off'
    this.captureBuffer = ''
    this.captureSegmentsSeen.clear()
  }

  /** Switch to wake word listening mode. */
  enterWake(triggers?: string[]): void {
    if (triggers) this.triggers = triggers.map(t => t.toLowerCase())
    this._state = 'wake'
    this.captureBuffer = ''
    this.captureSegmentsSeen.clear()
    this.stopSilenceMonitor()
    log.info('Entered WAKE state', { triggers: this.triggers })
  }

  /** Switch to capturing (dictation) mode — accumulates text until silence. */
  enterCapturing(silenceWindowMs?: number): void {
    if (silenceWindowMs !== undefined) this.silenceWindowMs = silenceWindowMs
    this._state = 'capturing'
    this.captureBuffer = ''
    this.captureSegmentsSeen.clear()
    this.recentSegments = []
    this.lastTextTime = Date.now()
    this.startSilenceMonitor()
    log.info('Entered CAPTURING state', { silenceWindowMs: this.silenceWindowMs })
  }

  /** Switch to idle — stream keeps running but text is ignored. */
  enterIdle(): void {
    this._state = 'idle'
    this.captureBuffer = ''
    this.captureSegmentsSeen.clear()
    this.stopSilenceMonitor()
    log.info('Entered IDLE state')
  }

  /** Update wake triggers. */
  setTriggers(triggers: string[]): void {
    this.triggers = triggers.map(t => t.toLowerCase())
    log.info('Triggers updated', { triggers: this.triggers })
  }

  /** Configure silence window for capturing. */
  setSilenceWindow(ms: number): void {
    this.silenceWindowMs = ms
  }

  /** Is the stream process running? */
  isRunning(): boolean { return this.proc !== null }

  // ── Private ───────────────────────────────────────────────────────────────

  private handleLine(raw: string): void {
    // Strip ANSI escapes, timestamps, and bracket markers
    const text = stripAnsi(raw).replace(/\[.*?\]/g, '').trim()
    if (!text) return
    // Filter whisper hallucinations during silence
    if (HALLUCINATION_RE.test(text)) {
      log.debug('Filtered hallucination', { text })
      return
    }
    // Global dedup — ignore text repeated within the dedup window
    const normalized = text.toLowerCase().trim()
    const now = Date.now()
    this.recentSegments = this.recentSegments.filter(s => now - s.time < WhisperStreamManager.DEDUP_WINDOW_MS)
    if (this.recentSegments.some(s => s.text === normalized)) {
      log.debug('Filtered duplicate segment', { text })
      return
    }
    this.recentSegments.push({ text: normalized, time: now })

    switch (this._state) {
      case 'wake':
        this.handleWakeText(text)
        break
      case 'capturing':
        this.handleCaptureText(text)
        break
      case 'idle':
      case 'off':
        // Ignore
        break
    }
  }

  private handleWakeText(text: string): void {
    if (Date.now() < this.cooldownUntil) {
      log.debug('Wake text ignored (cooldown)', { text })
      return
    }

    log.debug('Wake text', { text })

    const hit = matchTrigger(text, this.triggers)
    if (!hit) return

    this.cooldownUntil = Date.now() + WhisperStreamManager.WAKE_COOLDOWN_MS
    const command = extractAfter(text, hit)

    log.info('Wake trigger matched', { trigger: hit, command, fullText: text })

    if (isVACommand(command)) {
      log.info('VA activation command detected')
      this.emit('vaActivate')
    } else {
      this.emit('wake', { trigger: hit, command, fullText: text } satisfies WakeMatchEvent)
    }
  }

  private handleCaptureText(text: string): void {
    // Deduplicate — whisper stream can repeat segments with --keep-context
    const normalized = text.toLowerCase().trim()
    if (this.captureSegmentsSeen.has(normalized)) {
      log.debug('Capture text deduplicated', { text })
      return
    }
    this.captureSegmentsSeen.add(normalized)

    this.lastTextTime = Date.now()
    this.captureBuffer += (this.captureBuffer ? ' ' : '') + text
    log.debug('Capture text', { text, bufferLen: this.captureBuffer.length })
    this.emit('partial', this.captureBuffer)

    // Check for stop commands in real-time
    if (isStopCommand(this.captureBuffer, this.triggers)) {
      log.info('Stop command detected during capture', { text: this.captureBuffer })
      this.captureBuffer = ''
      this.captureSegmentsSeen.clear()
      this.emit('stopCommand')
      return
    }
  }

  private startSilenceMonitor(): void {
    this.stopSilenceMonitor()
    this.silenceTimer = setInterval(() => {
      if (this._state !== 'capturing') {
        this.stopSilenceMonitor()
        return
      }
      const elapsed = Date.now() - this.lastTextTime
      if (elapsed >= this.silenceWindowMs && this.captureBuffer.trim()) {
        const transcript = this.captureBuffer.trim()
        log.info('Silence detected — finalizing transcript', {
          silenceMs: elapsed,
          transcriptLen: transcript.length,
        })
        this.captureBuffer = ''
        this.captureSegmentsSeen.clear()
        this.stopSilenceMonitor()
        this.emit('transcript', transcript)
      }
    }, 200)
  }

  private stopSilenceMonitor(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
  }
}
