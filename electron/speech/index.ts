import { ipcMain, BrowserWindow, globalShortcut } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { detectCapabilities, getSetupInstructions } from './detect'
import { recognizeSpeech, stopTranscription } from './stt'
import { stopRecording } from './recorder'
import { WakeDetector, type WakeEvent } from './wake'
import { VoiceAssistant, isVAActivateCommand } from './assistant'
import { createLogger } from '../logger'

const log = createLogger('speech:ipc')
const childLog = createLogger('speech:child')

let wakeDetector: WakeDetector | null = null
let voiceAssistant: VoiceAssistant | null = null
let win: BrowserWindow | null = null
let windowsSpeechProcess: ChildProcess | null = null

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) {
    log.debug('IPC send → renderer', { channel })
    win.webContents.send(channel, ...args)
  } else {
    log.warn('Cannot send to renderer — window is null or destroyed', { channel })
  }
}

function windowsSpeechRecognize(timeoutSec: number): Promise<{ text: string; error?: string }> {
  if (windowsSpeechProcess) {
    log.warn('Killing previous Windows speech process', { pid: windowsSpeechProcess.pid })
    windowsSpeechProcess.kill()
    windowsSpeechProcess = null
  }
  return new Promise((resolve) => {
    const clampedTimeout = Math.max(5, Math.min(timeoutSec, 30))
    log.info('Starting Windows PowerShell speech recognition', { clampedTimeout })

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
    const pid = windowsSpeechProcess.pid
    log.info('Windows speech process spawned', { pid })

    let stdout = '', stderr = ''
    windowsSpeechProcess.stdout?.on('data', (d: Buffer) => {
      childLog.childStdout(`win-speech(${pid})`, d)
      stdout += d.toString()
    })
    windowsSpeechProcess.stderr?.on('data', (d: Buffer) => {
      childLog.childStderr(`win-speech(${pid})`, d)
      stderr += d.toString()
    })
    windowsSpeechProcess.on('close', (code, signal) => {
      log.info('Windows speech process exited', { pid, code, signal, stdoutLen: stdout.length, stderrLen: stderr.length })
      windowsSpeechProcess = null
      if (code === null) {
        log.info('Windows speech process was killed (user cancelled)')
        resolve({ text: '' })
      } else if (stderr.trim()) {
        log.error('Windows speech process returned stderr', stderr.trim())
        resolve({ text: '', error: stderr.trim() })
      } else {
        const text = stdout.trim()
        log.info('Windows speech result', { text: text || '(empty)' })
        resolve({ text })
      }
    })
    windowsSpeechProcess.on('error', (err) => {
      log.error('Windows speech process spawn error', { pid, error: err.message })
      windowsSpeechProcess = null
      resolve({ text: '', error: err.message })
    })
  })
}

export function setupSpeechHandlers(mainWindow: BrowserWindow): void {
  win = mainWindow
  log.info('Setting up speech IPC handlers')

  ipcMain.handle('speech:capabilities', () => {
    log.info('speech:capabilities requested')
    const caps = detectCapabilities()
    const result = { ...caps, setupInstructions: getSetupInstructions(caps) }
    log.info('speech:capabilities result', result)
    return result
  })

  ipcMain.handle('speech:available', () => {
    if (process.platform === 'win32') {
      log.debug('speech:available → true (Windows)')
      return true
    }
    const available = detectCapabilities().stt
    log.debug('speech:available', { platform: process.platform, available })
    return available
  })

  ipcMain.handle('speech:recognize', async (_event, timeoutSec: number = 15) => {
    log.info('speech:recognize called', { timeoutSec, platform: process.platform })
    if (process.platform === 'win32') return windowsSpeechRecognize(timeoutSec)
    const caps = detectCapabilities()
    if (!caps.stt) {
      const instructions = getSetupInstructions(caps).join(' ')
      log.warn('Speech not available for recognition', { instructions })
      return { text: '', error: 'Speech not available. ' + instructions }
    }
    return recognizeSpeech({ timeoutMs: timeoutSec * 1000 })
  })

  ipcMain.handle('speech:stop', () => {
    log.info('speech:stop called', { platform: process.platform })
    if (process.platform === 'win32' && windowsSpeechProcess) {
      log.info('Killing Windows speech process', { pid: windowsSpeechProcess.pid })
      windowsSpeechProcess.kill()
      windowsSpeechProcess = null
      return
    }
    stopTranscription()
    stopRecording()
  })

  // Wake word
  ipcMain.handle('speech:wakeStart', (_event, triggers: string[]) => {
    log.info('speech:wakeStart called', { triggers })
    if (!wakeDetector) {
      log.info('Creating new WakeDetector')
      wakeDetector = new WakeDetector()
      wakeDetector.on('wake', (ev: WakeEvent) => {
        const action = isVAActivateCommand(ev.text) ? 'startAssistant' : 'oneShot'
        log.info('Wake event → renderer', { ...ev, action })
        send('speech:wakeDetected', { ...ev, action })
      })
      wakeDetector.on('error', (e: Error) => log.error('WakeDetector error', { error: e.message }))
      wakeDetector.on('stopped', () => log.warn('WakeDetector stopped unexpectedly'))
    }
    const started = wakeDetector.start(triggers)
    log.info('WakeDetector start result', { started })
    return started
  })

  ipcMain.handle('speech:wakeStop', () => {
    log.info('speech:wakeStop called')
    wakeDetector?.stop()
  })

  ipcMain.handle('speech:wakeUpdateTriggers', (_event, triggers: string[]) => {
    log.info('speech:wakeUpdateTriggers', { triggers })
    wakeDetector?.updateTriggers(triggers)
  })

  // Voice Assistant
  ipcMain.handle('speech:vaStart', () => {
    log.info('speech:vaStart called')
    if (!voiceAssistant) {
      log.info('Creating new VoiceAssistant')
      voiceAssistant = new VoiceAssistant()
      voiceAssistant.on('phase', (p: string) => {
        log.debug('VA phase → renderer', { phase: p })
        send('speech:vaPhase', p)
      })
      voiceAssistant.on('transcript', (t: string) => {
        log.info('VA transcript → renderer', { text: t })
        send('speech:vaTranscript', t)
      })
      voiceAssistant.on('started', () => {
        log.info('VA started — stopping wake detector')
        wakeDetector?.stop()
        send('speech:vaStarted')
      })
      voiceAssistant.on('stopped', () => {
        log.info('VA stopped')
        send('speech:vaStopped')
      })
      voiceAssistant.on('error', (m: string) => {
        log.error('VA error → renderer', { error: m })
        send('speech:vaError', m)
      })
    }
    voiceAssistant.start()
    return true
  })

  ipcMain.handle('speech:vaStop', () => {
    log.info('speech:vaStop called')
    voiceAssistant?.stop()
  })

  ipcMain.handle('speech:vaConfigure', (_event, cfg: { wakeTriggers?: string[]; silenceTimeoutMs?: number; recordTimeoutMs?: number }) => {
    log.info('speech:vaConfigure called', cfg)
    voiceAssistant?.configure(cfg)
  })

  ipcMain.handle('speech:vaNotifySpeaking', () => {
    log.debug('speech:vaNotifySpeaking')
    voiceAssistant?.notifySpeaking()
  })

  ipcMain.handle('speech:vaNotifySpeakingDone', () => {
    log.debug('speech:vaNotifySpeakingDone')
    voiceAssistant?.notifySpeakingDone()
  })

  ipcMain.handle('speech:vaNotifyWaiting', () => {
    log.debug('speech:vaNotifyWaiting')
    voiceAssistant?.notifyWaiting()
  })

  // Global hotkey
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
  wakeDetector?.stop()
  voiceAssistant?.stop()
  try {
    globalShortcut.unregisterAll()
  } catch (err) {
    log.warn('Failed to unregister global shortcuts', { error: err instanceof Error ? err.message : String(err) })
  }
}
