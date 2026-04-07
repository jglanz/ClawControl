import { createLogger } from './logger'

const log = createLogger('audio')

let currentAudio: HTMLAudioElement | null = null
let currentBlobUrl: string | null = null

export function playBase64Audio(
  base64: string,
  mimeType = 'audio/mpeg',
  onEnd?: () => void,
  onError?: (err: string) => void,
): HTMLAudioElement {
  log.info('playBase64Audio called', { mimeType, base64Length: base64.length })
  stopAudio()

  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: mimeType })
  const url = URL.createObjectURL(blob)
  currentBlobUrl = url
  log.debug('Audio blob created', { blobSize: blob.size, blobUrl: url })

  const audio = new Audio(url)
  currentAudio = audio

  audio.onended = () => {
    log.info('Audio playback ended naturally')
    cleanup()
    onEnd?.()
  }
  audio.onerror = (e) => {
    log.error('Audio playback error', { error: String(e) })
    cleanup()
    onError?.('Audio playback failed')
  }
  audio.play().then(() => {
    log.info('Audio play() started successfully')
  }).catch((err) => {
    log.error('Audio play() rejected', { error: err.message })
    cleanup()
    onError?.(err.message)
  })

  return audio
}

export function stopAudio(): void {
  if (currentAudio) {
    log.info('Stopping current audio playback')
    currentAudio.pause()
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio = null
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl)
    currentBlobUrl = null
  }
}

export function isPlaying(): boolean {
  return currentAudio !== null && !currentAudio.paused
}

function cleanup(): void {
  currentAudio = null
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl)
    currentBlobUrl = null
  }
}
