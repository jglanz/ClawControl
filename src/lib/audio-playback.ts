let currentAudio: HTMLAudioElement | null = null
let currentBlobUrl: string | null = null

export function playBase64Audio(
  base64: string,
  mimeType = 'audio/mpeg',
  onEnd?: () => void,
  onError?: (err: string) => void,
): HTMLAudioElement {
  stopAudio()

  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: mimeType })
  const url = URL.createObjectURL(blob)
  currentBlobUrl = url

  const audio = new Audio(url)
  currentAudio = audio

  audio.onended = () => {
    cleanup()
    onEnd?.()
  }
  audio.onerror = (e) => {
    console.error('[audio-playback] Playback error:', e)
    cleanup()
    onError?.('Audio playback failed')
  }
  audio.play().catch((err) => {
    console.error('[audio-playback] play() rejected:', err.message)
    cleanup()
    onError?.(err.message)
  })

  return audio
}

export function stopAudio(): void {
  if (currentAudio) {
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
