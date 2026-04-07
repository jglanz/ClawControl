import { spawn, ChildProcess } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { detectCapabilities, getSpawnEnv } from './detect'
import { startRecording, stopRecording, type RecordingOptions } from './recorder'
import { createLogger } from '../logger'

const log = createLogger('speech:stt')

export interface TranscribeResult {
  text: string
  error?: string
}

let activeTranscription: ChildProcess | null = null

export function transcribeFile(wavPath: string, language = 'en', threads = 8): Promise<TranscribeResult> {
  const caps = detectCapabilities()
  if (!caps.whisperBinary || !caps.modelPath) {
    log.error('Whisper not available', { whisperBinary: caps.whisperBinary, modelPath: caps.modelPath })
    return Promise.resolve({ text: '', error: 'Whisper not available' })
  }
  if (!existsSync(wavPath)) {
    log.error('Audio file not found', { wavPath })
    return Promise.resolve({ text: '', error: `File not found: ${wavPath}` })
  }

  const args = [
    '-m', caps.modelPath,
    '-f', wavPath,
    '-l', language,
    '-t', String(threads),
    '--no-timestamps',
    '--print-progress', 'false',
  ]

  log.info('Starting transcription', { binary: caps.whisperBinary, wavPath, language, threads, model: caps.modelPath })
  log.debug('Whisper args', args.join(' '))

  return new Promise<TranscribeResult>((resolve) => {
    const proc = spawn(caps.whisperBinary!, args, { stdio: ['ignore', 'pipe', 'pipe'], env: getSpawnEnv() })
    activeTranscription = proc
    const pid = proc.pid
    log.info('Whisper process spawned', { pid })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stdout += chunk
      log.debug(`[whisper:stdout pid=${pid}] ${chunk.trimEnd()}`)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      log.debug(`[whisper:stderr pid=${pid}] ${chunk.trimEnd()}`)
    })

    proc.on('close', (code, signal) => {
      activeTranscription = null
      log.info('Whisper process exited', { pid, code, signal, stdoutLen: stdout.length, stderrLen: stderr.length })

      if (code === null) {
        log.info('Whisper process was killed')
        resolve({ text: '' })
        return
      }
      const text = stdout.replace(/\[.*?\]/g, '').trim()
      if (text) {
        log.info('Transcription result', { text, length: text.length })
      } else if (stderr.trim()) {
        log.error('Transcription failed', { exitCode: code, stderr: stderr.trim().slice(0, 500) })
      } else {
        log.warn('Transcription returned empty text', { exitCode: code })
      }
      resolve(text ? { text } : { text: '', error: stderr.trim().slice(0, 300) || undefined })
    })

    proc.on('error', (err) => {
      activeTranscription = null
      log.error('Failed to spawn whisper process', { pid, error: err.message, stack: err.stack })
      resolve({ text: '', error: err.message })
    })
  })
}

/** Record audio then transcribe — one-shot dictation. */
export async function recognizeSpeech(recordOpts?: RecordingOptions, language = 'en'): Promise<TranscribeResult> {
  log.info('recognizeSpeech: starting record → transcribe pipeline', { language, recordOpts })
  let wavPath: string | null = null
  try {
    const rec = await startRecording(recordOpts)
    wavPath = rec.wavPath
    log.info('Recording complete, starting transcription', { wavPath, durationMs: Math.round(rec.durationMs) })
    return await transcribeFile(wavPath, language)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('recognizeSpeech failed', { error: msg })
    return { text: '', error: msg || 'Recognition failed' }
  } finally {
    if (wavPath && existsSync(wavPath)) {
      try {
        unlinkSync(wavPath)
        log.debug('Cleaned up temp WAV', { wavPath })
      } catch (e) {
        log.warn('Failed to clean up temp WAV', { wavPath, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
}

export function stopTranscription(): void {
  if (activeTranscription) {
    log.info('Stopping active transcription', { pid: activeTranscription.pid })
    activeTranscription.kill()
    activeTranscription = null
  }
  stopRecording()
}
