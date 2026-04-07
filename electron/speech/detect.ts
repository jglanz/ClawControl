import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { createLogger } from '../logger'

const log = createLogger('speech:detect')

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
    const result = execSync(`which ${binary}`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
    if (result) log.debug(`which ${binary} → ${result}`)
    return result
  } catch {
    log.debug(`which ${binary} → not found`)
    return null
  }
}

function findRecorder(): SpeechCapabilities['recorder'] {
  log.debug('Searching for audio recorder...')
  if (process.platform === 'linux') {
    if (which('parec')) { log.info('Recorder found: parec'); return 'parec' }
    if (which('arecord')) { log.info('Recorder found: arecord'); return 'arecord' }
  }
  if (which('sox') || which('rec')) { log.info('Recorder found: sox'); return 'sox' }
  log.warn('No audio recorder found (tried parec, arecord, sox/rec)')
  return null
}

function findWhisperBinary(): string | null {
  log.debug('Searching for whisper binary...')
  const envPath = process.env.WHISPER_CPP_BINARY
  if (envPath && existsSync(envPath)) { log.info('Whisper binary from env: ' + envPath); return envPath }

  for (const name of ['whisper-cli', 'whisper-cpp']) {
    const p = which(name)
    if (p) { log.info('Whisper binary found: ' + p); return p }
  }
  log.warn('Whisper binary not found (tried whisper-cli, whisper-cpp, WHISPER_CPP_BINARY env)')
  return null
}

function findStreamBinary(): string | null {
  log.debug('Searching for whisper-stream binary...')
  const envPath = process.env.WHISPER_CPP_STREAM
  if (envPath && existsSync(envPath)) { log.info('Stream binary from env: ' + envPath); return envPath }

  for (const name of ['whisper-stream']) {
    const p = which(name)
    if (p) { log.info('Stream binary found: ' + p); return p }
  }

  const wb = findWhisperBinary()
  if (wb) {
    const sibling = join(wb, '..', 'stream')
    if (existsSync(sibling)) { log.info('Stream binary found as sibling: ' + sibling); return sibling }
  }
  log.warn('whisper-stream binary not found')
  return null
}

function findModel(): string | null {
  log.debug('Searching for whisper model...')
  const envModel = process.env.WHISPER_CPP_MODEL
  if (envModel && existsSync(envModel)) { log.info('Model from env: ' + envModel); return envModel }

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
      if (existsSync(p)) { log.info('Model found: ' + p); return p }
    }
  }
  log.warn('No whisper model found in any standard location')
  return null
}

function hasCuda(): boolean {
  try {
    execSync('nvidia-smi', { timeout: 5000, stdio: 'ignore' })
    log.info('CUDA available (nvidia-smi found)')
    return true
  } catch {
    log.debug('nvidia-smi not found — CUDA unavailable')
    return false
  }
}

let _cached: SpeechCapabilities | null = null

export function detectCapabilities(force = false): SpeechCapabilities {
  if (_cached && !force) return _cached
  log.info('Detecting speech capabilities...')
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
  log.info('Capabilities result', _cached)
  return _cached
}

/** Build spawn env with LD_LIBRARY_PATH pointing to whisper's lib dir. */
export function getSpawnEnv(): NodeJS.ProcessEnv {
  const caps = detectCapabilities()
  const env = { ...process.env }
  if (caps.whisperBinary) {
    const binDir = caps.whisperBinary.substring(0, caps.whisperBinary.lastIndexOf('/'))
    const libDir = join(binDir, '..', 'lib')
    if (existsSync(libDir)) {
      env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '')
      log.debug('Added to LD_LIBRARY_PATH: ' + libDir)
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
  if (out.length) log.info('Setup instructions needed', out)
  return out
}
