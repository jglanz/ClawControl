import { ipcMain, BrowserWindow, globalShortcut } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { detectCapabilities, getSetupInstructions } from './detect'
import { recognizeSpeech, stopTranscription } from './stt'
import { stopRecording } from './recorder'
import { WakeDetector, type WakeEvent } from './wake'
import { VoiceAssistant, isVAActivateCommand } from './assistant'

let wakeDetector: WakeDetector | null = null
let voiceAssistant: VoiceAssistant | null = null
let win: BrowserWindow | null = null
let windowsSpeechProcess: ChildProcess | null = null

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function windowsSpeechRecognize(timeoutSec: number): Promise<{ text: string; error?: string }> {
  if (windowsSpeechProcess) { windowsSpeechProcess.kill(); windowsSpeechProcess = null }
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

  ipcMain.handle('speech:capabilities', () => {
    const caps = detectCapabilities()
    return { ...caps, setupInstructions: getSetupInstructions(caps) }
  })

  ipcMain.handle('speech:available', () => {
    if (process.platform === 'win32') return true
    return detectCapabilities().stt
  })

  ipcMain.handle('speech:recognize', async (_event, timeoutSec: number = 15) => {
    if (process.platform === 'win32') return windowsSpeechRecognize(timeoutSec)
    const caps = detectCapabilities()
    if (!caps.stt) {
      return { text: '', error: 'Speech not available. ' + getSetupInstructions(caps).join(' ') }
    }
    return recognizeSpeech({ timeoutMs: timeoutSec * 1000 })
  })

  ipcMain.handle('speech:stop', () => {
    if (process.platform === 'win32' && windowsSpeechProcess) {
      windowsSpeechProcess.kill(); windowsSpeechProcess = null
      return
    }
    stopTranscription()
    stopRecording()
  })

  // Wake word
  ipcMain.handle('speech:wakeStart', (_event, triggers: string[]) => {
    if (!wakeDetector) {
      wakeDetector = new WakeDetector()
      wakeDetector.on('wake', (ev: WakeEvent) => {
        const action = isVAActivateCommand(ev.text) ? 'startAssistant' : 'oneShot'
        send('speech:wakeDetected', { ...ev, action })
      })
      wakeDetector.on('error', (e: Error) => console.error('Wake error:', e.message))
    }
    return wakeDetector.start(triggers)
  })

  ipcMain.handle('speech:wakeStop', () => { wakeDetector?.stop() })
  ipcMain.handle('speech:wakeUpdateTriggers', (_event, triggers: string[]) => { wakeDetector?.updateTriggers(triggers) })

  // Voice Assistant
  ipcMain.handle('speech:vaStart', () => {
    if (!voiceAssistant) {
      voiceAssistant = new VoiceAssistant()
      voiceAssistant.on('phase', (p: string) => send('speech:vaPhase', p))
      voiceAssistant.on('transcript', (t: string) => send('speech:vaTranscript', t))
      voiceAssistant.on('started', () => { wakeDetector?.stop(); send('speech:vaStarted') })
      voiceAssistant.on('stopped', () => send('speech:vaStopped'))
      voiceAssistant.on('error', (m: string) => send('speech:vaError', m))
    }
    voiceAssistant.start()
    return true
  })

  ipcMain.handle('speech:vaStop', () => { voiceAssistant?.stop() })
  ipcMain.handle('speech:vaConfigure', (_event, cfg: { wakeTriggers?: string[]; silenceTimeoutMs?: number; recordTimeoutMs?: number }) => { voiceAssistant?.configure(cfg) })
  ipcMain.handle('speech:vaNotifySpeaking', () => { voiceAssistant?.notifySpeaking() })
  ipcMain.handle('speech:vaNotifySpeakingDone', () => { voiceAssistant?.notifySpeakingDone() })
  ipcMain.handle('speech:vaNotifyWaiting', () => { voiceAssistant?.notifyWaiting() })

  // Global hotkey
  try {
    globalShortcut.register('Super+/', () => send('speech:hotkeyToggle'))
  } catch (err) {
    console.warn('Failed to register Super+/ hotkey:', err)
  }
}

export function cleanupSpeech(): void {
  wakeDetector?.stop()
  voiceAssistant?.stop()
  try { globalShortcut.unregisterAll() } catch (err) { console.warn('[speech] Failed to unregister global shortcuts:', err) }
}
