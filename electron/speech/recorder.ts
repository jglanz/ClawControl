import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import os from 'os'
import { detectCapabilities } from './detect'

export interface RecordingOptions {
  sampleRate?: number
  channels?: number
  timeoutMs?: number
}

export interface RecordingResult {
  wavPath: string
  durationMs: number
}

let activeRecording: ChildProcess | null = null

function getTempDir(): string {
  const dir = join(os.tmpdir(), 'clawcontrol-speech')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function buildWav(raw: Buffer, sampleRate: number, channels: number): Buffer {
  const bps = 16
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + raw.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * bps / 8, 28)
  header.writeUInt16LE(channels * bps / 8, 32)
  header.writeUInt16LE(bps, 34)
  header.write('data', 36)
  header.writeUInt32LE(raw.length, 40)
  return Buffer.concat([header, raw])
}

export function startRecording(options: RecordingOptions = {}): Promise<RecordingResult> {
  const { sampleRate = 16000, channels = 1, timeoutMs = 30000 } = options
  const caps = detectCapabilities()

  if (!caps.recorder) {
    console.error('[speech:recorder] No audio recording tool found (parec/arecord/sox)')
    return Promise.reject(new Error('No audio recording tool found. Install pulseaudio-utils or alsa-utils.'))
  }

  return new Promise((resolve, reject) => {
    const wavPath = join(getTempDir(), `rec-${Date.now()}.wav`)
    let binary: string
    let args: string[]

    switch (caps.recorder) {
      case 'parec':
        binary = 'parec'
        args = ['--format=s16le', `--rate=${sampleRate}`, `--channels=${channels}`, '--raw']
        break
      case 'arecord':
        binary = 'arecord'
        args = ['-f', 'S16_LE', '-r', String(sampleRate), '-c', String(channels), '-t', 'raw', '-q']
        break
      case 'sox':
        binary = 'rec'
        args = ['-r', String(sampleRate), '-c', String(channels), '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-']
        break
      default:
        return reject(new Error('Unknown recorder: ' + caps.recorder))
    }

    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    activeRecording = proc
    const chunks: Buffer[] = []

    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))

    const timer = setTimeout(() => stopRecording(), timeoutMs)

    proc.on('close', () => {
      clearTimeout(timer)
      activeRecording = null
      const raw = Buffer.concat(chunks)
      if (raw.length < 1600) {
        console.warn('[speech:recorder] Recording too short:', raw.length, 'bytes — no audio captured')
        reject(new Error('No audio captured'))
        return
      }
      writeFileSync(wavPath, buildWav(raw, sampleRate, channels))
      const durationMs = (raw.length / (sampleRate * channels * 2)) * 1000
      resolve({ wavPath, durationMs })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      activeRecording = null
      console.error('[speech:recorder] Recording process error:', err.message)
      reject(err)
    })
  })
}

export function stopRecording(): void {
  if (activeRecording) {
    activeRecording.kill('SIGTERM')
    activeRecording = null
  }
}
