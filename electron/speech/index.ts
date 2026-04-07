/**
 * Speech module — IPC handlers, global hotkey, orchestration.
 *
 * Primary engine: WhisperStreamManager (persistent process, low latency)
 * Fallback: record + whisper-cli transcription (higher latency, for one-shot only)
 */

import { ipcMain, BrowserWindow, globalShortcut } from 'electron'
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

  streamManager.on('wake', (ev: WakeMatchEvent) => {
    log.info('Wake event → renderer', ev)
    if (ev.command) {
      // Wake word + command text — send as one-shot message
      send('speech:wakeDetected', { ...ev, action: 'oneShot', text: ev.command })
    } else {
      // Wake word alone — start capturing for the next utterance
      send('speech:wakeDetected', { ...ev, action: 'capture', text: '' })
      streamManager?.enterCapturing()
    }
  })

  streamManager.on('vaActivate', () => {
    log.info('VA activation via wake command')
    send('speech:wakeDetected', { trigger: '', text: '', action: 'startAssistant' })
  })

  streamManager.on('transcript', (text: string) => {
    log.info('Transcript finalized', { text, vaActive })
    if (vaActive) {
      // Voice Assistant mode — emit as VA transcript
      send('speech:vaTranscript', text)
    } else {
      // One-shot dictation — emit as dictation result
      send('speech:dictationResult', { text })
      // Return to wake listening
      streamManager?.enterWake()
    }
  })

  streamManager.on('partial', (text: string) => {
    send('speech:partialTranscript', text)
  })

  streamManager.on('stopCommand', () => {
    log.info('Stop command detected — stopping VA')
    vaActive = false
    send('speech:vaStopped')
    streamManager?.enterWake()
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
    log.info('Starting Windows speech recognition', { clampedTimeout })
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

  // ── Capabilities ──────────────────────────────────────────────────────────
  ipcMain.handle('speech:capabilities', () => {
    const caps = detectCapabilities()
    return { ...caps, setupInstructions: getSetupInstructions(caps) }
  })

  ipcMain.handle('speech:available', () => {
    if (process.platform === 'win32') return true
    const caps = detectCapabilities()
    // Available if we have either streaming (preferred) or batch transcription
    return caps.wake || caps.stt
  })

  // ── One-shot dictation (mic button) ───────────────────────────────────────
  ipcMain.handle('speech:recognize', async (_event, timeoutSec: number = 15) => {
    log.info('speech:recognize called', { timeoutSec })
    if (process.platform === 'win32') return windowsSpeechRecognize(timeoutSec)

    // Prefer streaming: switch to capturing, wait for transcript
    const stream = getOrCreateStream()
    if (stream) {
      return new Promise<{ text: string; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup()
          stream.enterWake()
          resolve({ text: '' })
        }, timeoutSec * 1000)

        function cleanup() {
          clearTimeout(timeout)
          stream.removeListener('transcript', onTranscript)
          stream.removeListener('stopCommand', onStop)
        }
        function onTranscript(text: string) {
          cleanup()
          if (!vaActive) stream.enterWake()
          resolve({ text })
        }
        function onStop() {
          cleanup()
          stream.enterWake()
          resolve({ text: '' })
        }

        stream.on('transcript', onTranscript)
        stream.on('stopCommand', onStop)
        stream.enterCapturing()
      })
    }

    // Fallback: batch record + transcribe
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
    // If streaming, return to wake (don't kill the process)
    if (streamManager?.state === 'capturing') {
      streamManager.enterWake()
      return
    }
    stopTranscription()
    stopRecording()
  })

  // ── Wake word ─────────────────────────────────────────────────────────────
  ipcMain.handle('speech:wakeStart', (_event, triggers: string[]) => {
    log.info('speech:wakeStart called', { triggers })
    const stream = getOrCreateStream()
    if (!stream) return false
    stream.enterWake(triggers)
    return true
  })

  ipcMain.handle('speech:wakeStop', () => {
    log.info('speech:wakeStop called')
    if (streamManager?.state === 'wake') {
      streamManager.enterIdle()
    }
  })

  ipcMain.handle('speech:wakeUpdateTriggers', (_event, triggers: string[]) => {
    log.info('speech:wakeUpdateTriggers', { triggers })
    streamManager?.setTriggers(triggers)
  })

  // ── Voice Assistant ───────────────────────────────────────────────────────
  ipcMain.handle('speech:vaStart', () => {
    log.info('speech:vaStart called')
    const stream = getOrCreateStream()
    if (!stream) return false
    vaActive = true
    stream.enterCapturing()
    send('speech:vaStarted')
    send('speech:vaPhase', 'listening')
    return true
  })

  ipcMain.handle('speech:vaStop', () => {
    log.info('speech:vaStop called')
    vaActive = false
    streamManager?.enterWake()
    send('speech:vaStopped')
  })

  ipcMain.handle('speech:vaConfigure', (_event, cfg: { wakeTriggers?: string[]; silenceTimeoutMs?: number }) => {
    log.info('speech:vaConfigure', cfg)
    if (cfg.wakeTriggers) streamManager?.setTriggers(cfg.wakeTriggers)
    if (cfg.silenceTimeoutMs) streamManager?.setSilenceWindow(cfg.silenceTimeoutMs)
  })

  ipcMain.handle('speech:vaNotifySpeaking', () => {
    log.debug('speech:vaNotifySpeaking — entering idle (TTS playing)')
    streamManager?.enterIdle()
    send('speech:vaPhase', 'speaking')
  })

  ipcMain.handle('speech:vaNotifySpeakingDone', () => {
    log.info('speech:vaNotifySpeakingDone — resuming capture')
    if (vaActive) {
      streamManager?.enterCapturing()
      send('speech:vaPhase', 'listening')
    }
  })

  ipcMain.handle('speech:vaNotifyWaiting', () => {
    log.debug('speech:vaNotifyWaiting')
    // Stay in idle while waiting for server response
    streamManager?.enterIdle()
    send('speech:vaPhase', 'waiting')
  })

  // ── Global hotkey ─────────────────────────────────────────────────────────
  try {
    globalShortcut.register('Super+/', () => {
      log.info('Global hotkey Super+/ pressed')
      send('speech:hotkeyToggle')
    })
    log.info('Global hotkey Super+/ registered')
  } catch (err) {
    log.warn('Failed to register Super+/ hotkey', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function cleanupSpeech(): void {
  log.info('Cleaning up speech module')
  streamManager?.stop()
  streamManager = null
  vaActive = false
  try { globalShortcut.unregisterAll() } catch (err) {
    log.warn('Failed to unregister global shortcuts', { error: err instanceof Error ? err.message : String(err) })
  }
}
