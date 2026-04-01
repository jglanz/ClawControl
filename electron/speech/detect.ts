import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import os from 'os'

export interface SpeechCapabilities {
  stt: boolean
  wake: boolean
  tts: boolean
  recorder: 'parec' | 'arecord' | 'sox' | null
  whisperBinary: string | null
  streamBinary: string | null
  modelPath: string | null
  gpu: boolean
}

function which(binary: string): string | null {
  try {
    return execSync(`which ${binary}`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch (err) {
    console.debug(`[speech:detect] which ${binary}: not found`, err instanceof Error ? err.message : err)
    return null
  }
}

function findRecorder(): SpeechCapabilities['recorder'] {
  if (process.platform === 'linux') {
    if (which('parec')) return 'parec'
    if (which('arecord')) return 'arecord'
  }
  if (which('sox') || which('rec')) return 'sox'
  return null
}

function findWhisperBinary(): string | null {
  const envPath = process.env.WHISPER_CPP_BINARY
  if (envPath && existsSync(envPath)) return envPath

  for (const name of ['whisper-cli', 'whisper-cpp']) {
    const p = which(name)
    if (p) return p
  }
  return null
}

function findStreamBinary(): string | null {
  const envPath = process.env.WHISPER_CPP_STREAM
  if (envPath && existsSync(envPath)) return envPath

  for (const name of ['whisper-stream']) {
    const p = which(name)
    if (p) return p
  }

  const wb = findWhisperBinary()
  if (wb) {
    const sibling = join(wb, '..', 'stream')
    if (existsSync(sibling)) return sibling
  }
  return null
}

function findModel(): string | null {
  const envModel = process.env.WHISPER_CPP_MODEL
  if (envModel && existsSync(envModel)) return envModel

  const home = os.homedir()
  const dirs = [
    join(home, '.local', 'share', 'whisper-cpp'),
    join(home, '.cache', 'whisper'),
    join(home, '.whisper'),
    join(home, 'whisper.cpp', 'models'),
    '/usr/local/share/whisper-cpp/models',
    '/usr/share/whisper-cpp/models',
  ]
  const models = [
    'ggml-large-v3.bin', 'ggml-large-v3-turbo.bin', 'ggml-large-v2.bin',
    'ggml-large.bin', 'ggml-medium.bin', 'ggml-base.bin', 'ggml-small.bin', 'ggml-tiny.bin',
  ]

  for (const dir of dirs) {
    for (const model of models) {
      const p = join(dir, model)
      if (existsSync(p)) return p
    }
  }
  return null
}

function hasCuda(): boolean {
  try {
    execSync('nvidia-smi', { timeout: 5000, stdio: 'ignore' })
    return true
  } catch (err) {
    console.warn('[speech:detect] nvidia-smi not found, CUDA unavailable:', err instanceof Error ? err.message : err)
    return false
  }
}

let _cached: SpeechCapabilities | null = null

export function detectCapabilities(force = false): SpeechCapabilities {
  if (_cached && !force) return _cached
  const recorder = findRecorder()
  const whisperBinary = findWhisperBinary()
  const streamBinary = findStreamBinary()
  const modelPath = findModel()
  const gpu = hasCuda()

  _cached = {
    stt: !!whisperBinary && !!modelPath && !!recorder,
    wake: !!streamBinary && !!modelPath,
    tts: true,
    recorder, whisperBinary, streamBinary, modelPath, gpu,
  }
  return _cached
}

/** Build spawn env with LD_LIBRARY_PATH pointing to whisper's lib dir. */
export function getSpawnEnv(): NodeJS.ProcessEnv {
  const caps = detectCapabilities()
  const env = { ...process.env }
  if (caps.whisperBinary) {
    // Add sibling lib/ directory to LD_LIBRARY_PATH
    const binDir = caps.whisperBinary.substring(0, caps.whisperBinary.lastIndexOf('/'))
    const libDir = join(binDir, '..', 'lib')
    if (existsSync(libDir)) {
      env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '')
    }
  }
  return env
}

export function getSetupInstructions(caps: SpeechCapabilities): string[] {
  const out: string[] = []
  if (!caps.recorder) out.push('Install audio tools: sudo apt install pulseaudio-utils (parec) or alsa-utils (arecord)')
  if (!caps.whisperBinary) out.push('Install whisper.cpp with CUDA: cmake -B build -DGGML_CUDA=ON && cmake --build build')
  if (!caps.streamBinary) out.push('Build whisper.cpp stream: cmake --build build --target stream')
  if (!caps.modelPath) out.push('Download model: ./models/download-ggml-model.sh large-v3')
  if (!caps.gpu) out.push('NVIDIA GPU + CUDA recommended for performance')
  return out
}
