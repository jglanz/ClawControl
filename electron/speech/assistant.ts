import { EventEmitter } from 'events'
import { existsSync, unlinkSync } from 'fs'
import { startRecording, stopRecording } from './recorder'
import { transcribeFile, stopTranscription } from './stt'

export type VAPhase = 'idle' | 'listening' | 'transcribing' | 'waiting' | 'speaking'

const GENERIC_STOP_COMMANDS = ['stop assistant', 'stop voice', 'stop listening']

const VA_ACTIVATE_COMMANDS = [
  'start voice assistant', 'start assistant', 'voice mode',
  'start talking', 'voice assistant', 'start voice',
]

export function isVAActivateCommand(text: string): boolean {
  const lower = text.toLowerCase().trim()
  return VA_ACTIVATE_COMMANDS.some(cmd => lower.includes(cmd))
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

  configure(opts: { wakeTriggers?: string[]; silenceTimeoutMs?: number; recordTimeoutMs?: number }): void {
    if (opts.wakeTriggers) this.wakeTriggers = opts.wakeTriggers
    if (opts.recordTimeoutMs !== undefined) this.recordTimeoutMs = opts.recordTimeoutMs
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.setPhase('listening')
    this.emit('started')
    void this.loop()
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    stopTranscription()
    stopRecording()
    this.setPhase('idle')
    this.emit('stopped')
  }

  isActive(): boolean { return this.active }
  getPhase(): VAPhase { return this.phase }

  notifyWaiting(): void { if (this.active) this.setPhase('waiting') }
  notifySpeaking(): void { if (this.active) this.setPhase('speaking') }
  notifySpeakingDone(): void {
    if (!this.active) return
    this.setPhase('listening')
    void this.loop()
  }

  private setPhase(p: VAPhase): void {
    this.phase = p
    this.emit('phase', p)
  }

  private async loop(): Promise<void> {
    if (!this.active) return
    this.setPhase('listening')

    try {
      const rec = await startRecording({ timeoutMs: this.recordTimeoutMs })
      if (!this.active) return
      this.setPhase('transcribing')
      const result = await transcribeFile(rec.wavPath)
      if (existsSync(rec.wavPath)) try { unlinkSync(rec.wavPath) } catch (e) { console.warn('[speech:va] Failed to clean up temp WAV:', rec.wavPath, e) }
      if (!this.active) return

      const text = result.text.trim()
      if (!text) {
        if (this.active) void this.loop()
        return
      }

      if (isStopCommand(text, this.wakeTriggers)) {
        this.stop()
        return
      }

      this.emit('transcript', text)
      this.setPhase('waiting')
    } catch (err) {
      if (!this.active) return
      const msg = err instanceof Error ? err.message : 'Listen failed'
      console.error('[speech:va] Loop error:', msg)
      this.emit('error', msg)
      setTimeout(() => { if (this.active) void this.loop() }, 1000)
    }
  }
}
