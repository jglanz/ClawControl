import { spawn, ChildProcess } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { detectCapabilities, getSpawnEnv } from './detect'
import { startRecording, stopRecording, type RecordingOptions } from './recorder'

export interface TranscribeResult {
  text: string
  error?: string
}

let activeTranscription: ChildProcess | null = null

export function transcribeFile(wavPath: string, language = 'en', threads = 8): Promise<TranscribeResult> {
  const caps = detectCapabilities()
  if (!caps.whisperBinary || !caps.modelPath) {
    console.error('[speech:stt] Whisper not available — binary:', caps.whisperBinary, 'model:', caps.modelPath)
    return Promise.resolve({ text: '', error: 'Whisper not available' })
  }
  if (!existsSync(wavPath)) {
    console.error('[speech:stt] Audio file not found:', wavPath)
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

  return new Promise<TranscribeResult>((resolve) => {
    const proc = spawn(caps.whisperBinary!, args, { stdio: ['ignore', 'pipe', 'pipe'], env: getSpawnEnv() })
    activeTranscription = proc

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      activeTranscription = null
      if (code === null) { resolve({ text: '' }); return }
      const text = stdout.replace(/\[.*?\]/g, '').trim()
      if (!text && stderr.trim()) {
        console.error('[speech:stt] Transcription failed (exit code', code, '):', stderr.trim().slice(0, 300))
      }
      resolve(text ? { text } : { text: '', error: stderr.trim().slice(0, 300) || undefined })
    })

    proc.on('error', (err) => {
      activeTranscription = null
      console.error('[speech:stt] Failed to spawn whisper-cli:', err.message)
      resolve({ text: '', error: err.message })
    })
  })
}

/** Record audio then transcribe — one-shot dictation. */
export async function recognizeSpeech(recordOpts?: RecordingOptions, language = 'en'): Promise<TranscribeResult> {
  let wavPath: string | null = null
  try {
    const rec = await startRecording(recordOpts)
    wavPath = rec.wavPath
    return await transcribeFile(wavPath, language)
  } catch (err) {
    console.error('[speech:stt] recognizeSpeech failed:', err instanceof Error ? err.message : err)
    return { text: '', error: err instanceof Error ? err.message : 'Recognition failed' }
  } finally {
    if (wavPath && existsSync(wavPath)) try { unlinkSync(wavPath) } catch (e) { console.warn('[speech:stt] Failed to clean up temp WAV:', wavPath, e) }
  }
}

export function stopTranscription(): void {
  if (activeTranscription) { activeTranscription.kill(); activeTranscription = null }
  stopRecording()
}
