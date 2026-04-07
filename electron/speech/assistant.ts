import { EventEmitter } from 'events'
import { existsSync, unlinkSync } from 'fs'
import { startRecording, stopRecording } from './recorder'
import { transcribeFile, stopTranscription } from './stt'
import { createLogger } from '../logger'

const log = createLogger('speech:va')

export type VAPhase = 'idle' | 'listening' | 'transcribing' | 'waiting' | 'speaking'

const GENERIC_STOP_COMMANDS = ['stop assistant', 'stop voice', 'stop listening']

const VA_ACTIVATE_COMMANDS = [
  'start voice assistant', 'start assistant', 'voice mode',
  'start talking', 'voice assistant', 'start voice',
]

export function isVAActivateCommand(text: string): boolean {
  const lower = text.toLowerCase().trim()
  const match = VA_ACTIVATE_COMMANDS.some(cmd => lower.includes(cmd))
  if (match) log.debug('VA activate command detected', { text })
  return match
}

function isStopCommand(text: string, triggers: string[]): boolean {
  const lower = text.toLowerCase().trim()
  if (GENERIC_STOP_COMMANDS.some(c => lower.includes(c))) return true
  return triggers.some(t => lower.includes(`stop ${t.toLowerCase()}`))
}

export class VoiceAssistant extends EventEmitter {
  private active = false
  private phase: VAPhase = 'idle'
  private wakeTriggers: string[] = []
  private recordTimeoutMs = 30000
  private loopCount = 0

  configure(opts: { wakeTriggers?: string[]; silenceTimeoutMs?: number; recordTimeoutMs?: number }): void {
    log.info('VA configure', opts)
    if (opts.wakeTriggers) this.wakeTriggers = opts.wakeTriggers
    if (opts.recordTimeoutMs !== undefined) this.recordTimeoutMs = opts.recordTimeoutMs
  }

  start(): void {
    if (this.active) {
      log.debug('VA start() called but already active')
      return
    }
    log.info('Voice Assistant starting')
    this.active = true
    this.loopCount = 0
    this.setPhase('listening')
    this.emit('started')
    void this.loop()
  }

  stop(): void {
    if (!this.active) {
      log.debug('VA stop() called but not active')
      return
    }
    log.info('Voice Assistant stopping', { loopCount: this.loopCount })
    this.active = false
    stopTranscription()
    stopRecording()
    this.setPhase('idle')
    this.emit('stopped')
  }

  isActive(): boolean { return this.active }
  getPhase(): VAPhase { return this.phase }

  notifyWaiting(): void {
    if (this.active) {
      log.debug('VA notifyWaiting')
      this.setPhase('waiting')
    }
  }

  notifySpeaking(): void {
    if (this.active) {
      log.debug('VA notifySpeaking')
      this.setPhase('speaking')
    }
  }

  notifySpeakingDone(): void {
    if (!this.active) return
    log.info('VA speaking done — resuming listen loop')
    this.setPhase('listening')
    void this.loop()
  }

  private setPhase(p: VAPhase): void {
    const prev = this.phase
    this.phase = p
    if (prev !== p) log.info('VA phase change', { from: prev, to: p })
    this.emit('phase', p)
  }

  private async loop(): Promise<void> {
    if (!this.active) return
    this.loopCount++
    const iteration = this.loopCount
    log.info(`VA loop iteration #${iteration} — starting recording`, { recordTimeoutMs: this.recordTimeoutMs })
    this.setPhase('listening')

    try {
      const rec = await startRecording({ timeoutMs: this.recordTimeoutMs })
      if (!this.active) {
        log.debug(`VA loop #${iteration} — aborted (no longer active after recording)`)
        return
      }
      log.info(`VA loop #${iteration} — recording complete, transcribing`, { wavPath: rec.wavPath, durationMs: Math.round(rec.durationMs) })
      this.setPhase('transcribing')
      const result = await transcribeFile(rec.wavPath)

      if (existsSync(rec.wavPath)) {
        try { unlinkSync(rec.wavPath) } catch (e) {
          log.warn('Failed to clean up temp WAV', { wavPath: rec.wavPath, error: e instanceof Error ? e.message : String(e) })
        }
      }

      if (!this.active) {
        log.debug(`VA loop #${iteration} — aborted (no longer active after transcription)`)
        return
      }

      const text = result.text.trim()
      if (!text) {
        log.info(`VA loop #${iteration} — empty transcript, restarting loop`)
        if (this.active) void this.loop()
        return
      }

      log.info(`VA loop #${iteration} — transcript`, { text })

      if (isStopCommand(text, this.wakeTriggers)) {
        log.info(`VA loop #${iteration} — stop command detected, stopping VA`, { text })
        this.stop()
        return
      }

      this.emit('transcript', text)
      this.setPhase('waiting')
      log.info(`VA loop #${iteration} — transcript emitted, waiting for response`)
    } catch (err) {
      if (!this.active) return
      const msg = err instanceof Error ? err.message : 'Listen failed'
      log.error(`VA loop #${iteration} error`, { error: msg, stack: err instanceof Error ? err.stack : undefined })
      this.emit('error', msg)
      log.info(`VA loop #${iteration} — retrying in 1s after error`)
      setTimeout(() => { if (this.active) void this.loop() }, 1000)
    }
  }
}
