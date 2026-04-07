/**
 * Speech module — IPC handlers, global hotkey, orchestration.
 *
 * Architecture: Always in WAKE mode. Every utterance requires the wake word.
 * The text after the wake word IS the command/message — no separate capturing state.
 * This eliminates TTS feedback issues entirely since the mic only processes
 * text that follows a wake trigger.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { detectCapabilities, getSetupInstructions } from './detect'
import { recognizeSpeech, stopTranscription } from './stt'
import { stopRecording } from './recorder'
import { WhisperStreamManager, type WakeMatchEvent } from './stream-manager'
import { createLogger } from '../logger'

const log = createLogger('speech:ipc')

let streamManager: WhisperStreamManager | null = null
let win: BrowserWindow | null = null
let windowsSpeechProcess: ChildProcess | null = null
let vaActive = false

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) {
    log.debug('IPC send → renderer', { channel })
    win.webContents.send(channel, ...args)
  } else {
    log.warn('Cannot send to renderer — window is null or destroyed', { channel })
  }
}

function getOrCreateStream(): WhisperStreamManager | null {
  if (streamManager?.isRunning()) return streamManager

  const caps = detectCapabilities()
  if (!caps.streamBinary || !caps.modelPath) {
    log.warn('Cannot create stream manager — missing stream binary or model')
    return null
  }

  streamManager = new WhisperStreamManager()

  // Wake word matched — the command text is everything after the trigger
  streamManager.on('wake', (ev: WakeMatchEvent) => {
    log.info('Wake event', { ...ev, vaActive })

    if (vaActive) {
      // VA mode: send command as VA transcript, then enter idle for TTS
      if (ev.command) {
        streamManager?.enterIdle()
        send('speech:vaPhase', 'waiting')
        send('speech:vaTranscript', ev.command)
      }
      // No command after wake word — just ignore, stay in wake
    } else {
      // Normal mode: forward to renderer
      if (ev.command) {
        send('speech:wakeDetected', { ...ev, action: 'oneShot', text: ev.command })
      }
      // No command — ignore
    }
  })

  streamManager.on('vaActivate', () => {
    log.info('VA activation via wake command')
    send('speech:wakeDetected', { trigger: '', text: '', action: 'startAssistant' })
  })

  streamManager.on('stopCommand', () => {
    log.info('Stop command detected — stopping VA')
    vaActive = false
    send('speech:vaStopped')
    // Already in wake mode, just stay there
  })

  streamManager.on('stopped', () => {
    log.warn('Stream manager stopped unexpectedly')
  })

  streamManager.on('error', (err: Error) => {
    log.error('Stream manager error', { error: err.message })
  })

  if (!streamManager.start()) {
    log.error('Failed to start stream manager')
    streamManager = null
    return null
  }

  return streamManager
}

function windowsSpeechRecognize(timeoutSec: number): Promise<{ text: string; error?: string }> {
  if (windowsSpeechProcess) {
    windowsSpeechProcess.kill()
    windowsSpeechProcess = null
  }
  return new Promise((resolve) => {
    const clampedTimeout = Math.max(5, Math.min(timeoutSec, 30))
    const script = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      Add-Type -AssemblyName System.Speech
      $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
      $rec.SetInputToDefaultAudioDevice()
      $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
      $result = $rec.Recognize((New-Object TimeSpan 0,0,${clampedTimeout}))
      if ($result) { Write-Output $result.Text }
      $rec.Dispose()
    `
    windowsSpeechProcess = spawn('powershell', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    windowsSpeechProcess.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    windowsSpeechProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    windowsSpeechProcess.on('close', (code) => {
      windowsSpeechProcess = null
      if (code === null) resolve({ text: '' })
      else if (stderr.trim()) resolve({ text: '', error: stderr.trim() })
      else resolve({ text: stdout.trim() })
    })
    windowsSpeechProcess.on('error', (err) => {
      windowsSpeechProcess = null
      resolve({ text: '', error: err.message })
    })
  })
}

export function setupSpeechHandlers(mainWindow: BrowserWindow): void {
  win = mainWindow
  log.info('Setting up speech IPC handlers')

  ipcMain.handle('speech:capabilities', () => {
    const caps = detectCapabilities()
    return { ...caps, setupInstructions: getSetupInstructions(caps) }
  })

  ipcMain.handle('speech:available', () => {
    if (process.platform === 'win32') return true
    const caps = detectCapabilities()
    return caps.wake || caps.stt
  })

  // One-shot dictation via mic button — fallback only (batch mode)
  ipcMain.handle('speech:recognize', async (_event, timeoutSec: number = 15) => {
    log.info('speech:recognize called', { timeoutSec })
    if (process.platform === 'win32') return windowsSpeechRecognize(timeoutSec)
    const caps = detectCapabilities()
    if (!caps.stt) {
      return { text: '', error: 'Speech not available. ' + getSetupInstructions(caps).join(' ') }
    }
    return recognizeSpeech({ timeoutMs: timeoutSec * 1000 })
  })

  ipcMain.handle('speech:stop', () => {
    log.info('speech:stop called')
    if (process.platform === 'win32' && windowsSpeechProcess) {
      windowsSpeechProcess.kill()
      windowsSpeechProcess = null
      return
    }
    stopTranscription()
    stopRecording()
  })

  // ── Wake word — always-on ─────────────────────────────────────────────────
  ipcMain.handle('speech:wakeStart', (_event, triggers: string[]) => {
    log.info('speech:wakeStart', { triggers })
    const stream = getOrCreateStream()
    if (!stream) return false
    stream.enterWake(triggers)
    return true
  })

  ipcMain.handle('speech:wakeStop', () => {
    log.info('speech:wakeStop')
    streamManager?.enterIdle()
  })

  ipcMain.handle('speech:wakeUpdateTriggers', (_event, triggers: string[]) => {
    log.info('speech:wakeUpdateTriggers', { triggers })
    streamManager?.setTriggers(triggers)
  })

  // ── Voice Assistant ───────────────────────────────────────────────────────
  // VA mode just sets a flag. Stream stays in wake mode.
  // Every utterance still requires wake word. Command text after wake word
  // gets sent as VA transcript instead of one-shot.
  ipcMain.handle('speech:vaStart', () => {
    log.info('speech:vaStart')
    const stream = getOrCreateStream()
    if (!stream) return false
    vaActive = true
    stream.enterWake()
    send('speech:vaStarted')
    send('speech:vaPhase', 'listening')
    return true
  })

  ipcMain.handle('speech:vaStop', () => {
    log.info('speech:vaStop')
    vaActive = false
    send('speech:vaStopped')
  })

  ipcMain.handle('speech:vaConfigure', (_event, cfg: { wakeTriggers?: string[]; silenceTimeoutMs?: number }) => {
    log.info('speech:vaConfigure', cfg)
    if (cfg.wakeTriggers) streamManager?.setTriggers(cfg.wakeTriggers)
    if (cfg.silenceTimeoutMs) streamManager?.setSilenceWindow(cfg.silenceTimeoutMs)
  })

  // TTS speaking/done — enter idle during playback, back to wake after
  ipcMain.handle('speech:vaNotifySpeaking', () => {
    log.debug('speech:vaNotifySpeaking — idle during TTS')
    streamManager?.enterIdle()
    send('speech:vaPhase', 'speaking')
  })

  ipcMain.handle('speech:vaNotifySpeakingDone', () => {
    log.info('speech:vaNotifySpeakingDone — back to wake')
    if (vaActive) {
      streamManager?.enterWake()
      send('speech:vaPhase', 'listening')
    }
  })

  ipcMain.handle('speech:vaNotifyWaiting', () => {
    log.debug('speech:vaNotifyWaiting — idle during response')
    streamManager?.enterIdle()
    send('speech:vaPhase', 'waiting')
  })

}

export function cleanupSpeech(): void {
  log.info('Cleaning up speech module')
  streamManager?.stop()
  streamManager = null
  vaActive = false
}
