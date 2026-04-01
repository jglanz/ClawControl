import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { getPlatform } from '../lib/platform'
import { playBase64Audio, stopAudio } from '../lib/audio-playback'

const PHASE_LABELS: Record<string, string> = {
  listening: 'Listening...',
  transcribing: 'Transcribing...',
  waiting: 'Thinking...',
  speaking: 'Speaking...',
  idle: '',
}

export function TalkOverlay() {
  const {
    voiceAssistantActive,
    voiceAssistantPhase,
    stopVoiceAssistant,
  } = useStore()
  const lastTranscriptRef = useRef('')
  const wiredRef = useRef(false)
  const api = (window as any).electronAPI

  // Wire up VA events from main process — runs once on mount
  useEffect(() => {
    if (getPlatform() !== 'electron' || !api || wiredRef.current) return
    wiredRef.current = true

    api.onVAPhase?.((phase: string) => {
      useStore.setState({ voiceAssistantPhase: phase as any })
    })

    api.onVATranscript?.((text: string) => {
      lastTranscriptRef.current = text
      void handleTranscript(text)
    })

    api.onVAStopped?.(() => {
      stopAudio()
      useStore.setState({ voiceAssistantActive: false, voiceAssistantPhase: 'idle' })
    })

    api.onVAError?.((msg: string) => {
      console.warn('VA error:', msg)
    })
  }, [])

  async function handleTranscript(text: string) {
    const state = useStore.getState()
    await state.sendMessage(text)
    api?.vaNotifyWaiting?.()

    // Watch for streaming to complete, then speak the response
    const unsub = useStore.subscribe((s) => {
      const sid = s.currentSessionId || ''
      if (!(s.streamingSessions as Record<string, boolean>)[sid] && s.voiceAssistantActive) {
        unsub()
        void speakLastResponse()
      }
    })
  }

  async function speakLastResponse() {
    const state = useStore.getState()
    if (!state.client || !state.voiceAssistantActive) {
      api?.vaNotifySpeakingDone?.()
      return
    }

    const msgs = state.messages || []
    const last = [...msgs].reverse().find(m => m.role === 'assistant')
    if (!last?.content?.trim()) {
      api?.vaNotifySpeakingDone?.()
      return
    }

    try {
      api?.vaNotifySpeaking?.()
      const result = await state.client.talkSpeak({ text: last.content })
      if (result?.audioBase64) {
        playBase64Audio(
          result.audioBase64,
          result.mimeType || 'audio/mpeg',
          () => api?.vaNotifySpeakingDone?.(),
          (err) => { console.error('[TalkOverlay] Audio playback error:', err); api?.vaNotifySpeakingDone?.() },
        )
      } else {
        console.warn('[TalkOverlay] talk.speak returned no audio — TTS may not be configured')
        api?.vaNotifySpeakingDone?.()
      }
    } catch (err) {
      console.error('[TalkOverlay] talk.speak failed:', err)
      api?.vaNotifySpeakingDone?.()
    }
  }

  if (!voiceAssistantActive) return null

  return (
    <div className="talk-overlay" data-phase={voiceAssistantPhase}>
      <div className="talk-overlay-content">
        <div className="talk-phase-indicator">
          <div className="talk-pulse-ring" />
          <div className="talk-pulse-ring delay-1" />
          <div className="talk-pulse-ring delay-2" />
          <svg className="talk-mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
            <path d="M19 11a7 7 0 0 1-14 0" />
            <path d="M12 18v3" />
          </svg>
        </div>
        <span className="talk-phase-label">{PHASE_LABELS[voiceAssistantPhase] || ''}</span>
        {lastTranscriptRef.current && voiceAssistantPhase !== 'listening' && (
          <span className="talk-transcript">{lastTranscriptRef.current}</span>
        )}
        <button className="talk-stop-btn" onClick={stopVoiceAssistant} aria-label="Stop Voice Assistant">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          Stop
        </button>
      </div>
    </div>
  )
}
