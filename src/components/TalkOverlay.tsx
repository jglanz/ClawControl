import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { getPlatform } from '../lib/platform'
import { playBase64Audio, stopAudio } from '../lib/audio-playback'
import { createLogger } from '../lib/logger'

const log = createLogger('talk-overlay')

export function VoiceAssistantBridge() {
  const lastTranscriptRef = useRef('')
  const wiredRef = useRef(false)
  const api = (window as any).electronAPI

  // Wire up VA events from main process — runs once on mount
  useEffect(() => {
    if (getPlatform() !== 'electron' || !api || wiredRef.current) return
    wiredRef.current = true
    log.info('Wiring up VA event listeners from main process')

    api.onVAPhase?.((phase: string) => {
      log.debug('VA phase event received', { phase })
      useStore.setState({ voiceAssistantPhase: phase as any })
    })

    api.onVATranscript?.((text: string) => {
      log.info('VA transcript received', { text })
      lastTranscriptRef.current = text
      void handleTranscript(text)
    })

    api.onVAStopped?.(() => {
      log.info('VA stopped event received')
      stopAudio()
      useStore.setState({ voiceAssistantActive: false, voiceAssistantPhase: 'idle' })
    })

    api.onVAError?.((msg: string) => {
      log.error('VA error event received', { error: msg })
    })
  }, [])

  async function handleTranscript(text: string) {
    log.info('handleTranscript: sending message to chat', { text })
    const state = useStore.getState()
    await state.sendMessage(text)
    log.debug('handleTranscript: message sent, notifying VA to wait')
    api?.vaNotifyWaiting?.()

    // Watch for streaming to complete, then speak the response
    const unsub = useStore.subscribe((s) => {
      const sid = s.currentSessionId || ''
      if (!(s.streamingSessions as Record<string, boolean>)[sid] && s.voiceAssistantActive) {
        unsub()
        log.info('Streaming complete — initiating TTS for response')
        void speakLastResponse()
      }
    })
  }

  async function speakLastResponse() {
    const state = useStore.getState()
    if (!state.client || !state.voiceAssistantActive) {
      log.warn('speakLastResponse: skipping — client or VA not active')
      api?.vaNotifySpeakingDone?.()
      return
    }

    const msgs = state.messages || []
    const last = [...msgs].reverse().find(m => m.role === 'assistant')
    if (!last?.content?.trim()) {
      log.warn('speakLastResponse: no assistant message to speak')
      api?.vaNotifySpeakingDone?.()
      return
    }

    try {
      log.info('speakLastResponse: calling talk.speak', { contentLength: last.content.length })
      api?.vaNotifySpeaking?.()
      const result = await state.client.talkSpeak({ text: last.content })
      if (result?.audioBase64) {
        log.info('speakLastResponse: received audio', { mimeType: result.mimeType, audioLength: result.audioBase64.length })
        playBase64Audio(
          result.audioBase64,
          result.mimeType || 'audio/mpeg',
          () => {
            log.info('speakLastResponse: audio playback ended')
            api?.vaNotifySpeakingDone?.()
          },
          (err) => {
            log.error('speakLastResponse: audio playback error', { error: err })
            api?.vaNotifySpeakingDone?.()
          },
        )
      } else {
        log.warn('speakLastResponse: talk.speak returned no audio — TTS may not be configured')
        api?.vaNotifySpeakingDone?.()
      }
    } catch (err) {
      log.error('speakLastResponse: talk.speak failed', { error: err instanceof Error ? err.message : String(err) })
      api?.vaNotifySpeakingDone?.()
    }
  }

  return null
}
