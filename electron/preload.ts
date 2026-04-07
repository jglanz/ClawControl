import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Connection
  connect: (url: string) => ipcRenderer.invoke('openclaw:connect', url),
  getConfig: () => ipcRenderer.invoke('openclaw:getConfig'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  trustHost: (hostname: string) => ipcRenderer.invoke('cert:trustHost', hostname),

  // Auth
  saveToken: (token: string) => ipcRenderer.invoke('auth:saveToken', token),
  getToken: () => ipcRenderer.invoke('auth:getToken'),
  isEncryptionAvailable: () => ipcRenderer.invoke('auth:isEncryptionAvailable'),

  // Notifications
  showNotification: (title: string, body: string) => ipcRenderer.invoke('notification:show', title, body),

  // Popouts
  openSubagentPopout: (params: { sessionKey: string; serverUrl: string; authToken: string; authMode: string; label: string }) =>
    ipcRenderer.invoke('subagent:openPopout', params),
  openToolCallPopout: (params: { toolCallId: string; name: string }) =>
    ipcRenderer.invoke('toolcall:openPopout', params),

  // Network
  fetchUrl: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => ipcRenderer.invoke('net:fetchUrl', url, options),
  clawhubInstall: (slug: string, targetDir: string) => ipcRenderer.invoke('clawhub:install', slug, targetDir),

  // Crypto
  generateEd25519KeyPair: () => ipcRenderer.invoke('crypto:generateEd25519'),
  signEd25519: (privateKeyJwk: JsonWebKey, payload: string) => ipcRenderer.invoke('crypto:signEd25519', privateKeyJwk, payload),

  // Clipboard / Device
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  getDeviceStatus: () => ipcRenderer.invoke('device:status'),

  // Speech — one-shot
  speechRecognize: (timeoutSec?: number) => ipcRenderer.invoke('speech:recognize', timeoutSec),
  speechStop: () => ipcRenderer.invoke('speech:stop'),
  speechAvailable: () => ipcRenderer.invoke('speech:available'),
  speechCapabilities: () => ipcRenderer.invoke('speech:capabilities'),

  // Speech — wake word
  wakeStart: (triggers: string[]) => ipcRenderer.invoke('speech:wakeStart', triggers),
  wakeStop: () => ipcRenderer.invoke('speech:wakeStop'),
  wakeUpdateTriggers: (triggers: string[]) => ipcRenderer.invoke('speech:wakeUpdateTriggers', triggers),
  onWakeDetected: (cb: (data: { trigger: string; text: string; fullText: string; action: string }) => void) => {
    ipcRenderer.on('speech:wakeDetected', (_e, data) => cb(data))
  },

  // Speech — Voice Assistant
  vaStart: () => ipcRenderer.invoke('speech:vaStart'),
  vaStop: () => ipcRenderer.invoke('speech:vaStop'),
  vaConfigure: (cfg: { wakeTriggers?: string[]; silenceTimeoutMs?: number; recordTimeoutMs?: number }) => ipcRenderer.invoke('speech:vaConfigure', cfg),
  vaNotifySpeaking: () => ipcRenderer.invoke('speech:vaNotifySpeaking'),
  vaNotifySpeakingDone: () => ipcRenderer.invoke('speech:vaNotifySpeakingDone'),
  vaNotifyWaiting: () => ipcRenderer.invoke('speech:vaNotifyWaiting'),
  onVAPhase: (cb: (phase: string) => void) => { ipcRenderer.on('speech:vaPhase', (_e, p) => cb(p)) },
  onVATranscript: (cb: (text: string) => void) => { ipcRenderer.on('speech:vaTranscript', (_e, t) => cb(t)) },
  onVAStarted: (cb: () => void) => { ipcRenderer.on('speech:vaStarted', () => cb()) },
  onVAStopped: (cb: () => void) => { ipcRenderer.on('speech:vaStopped', () => cb()) },
  onVAError: (cb: (msg: string) => void) => { ipcRenderer.on('speech:vaError', (_e, m) => cb(m)) },
  onHotkeyToggle: (cb: () => void) => { ipcRenderer.on('speech:hotkeyToggle', () => cb()) },
  onPartialTranscript: (cb: (text: string) => void) => { ipcRenderer.on('speech:partialTranscript', (_e, t) => cb(t)) },
  onDictationResult: (cb: (data: { text: string }) => void) => { ipcRenderer.on('speech:dictationResult', (_e, d) => cb(d)) },

  // Popout auth
  logForward: (level: string, category: string, message: string, data?: string) =>
    ipcRenderer.send('log:forward', level, category, message, data),
  getLogFilePath: () => ipcRenderer.invoke('log:getFilePath'),
  onPopoutAuthToken: (callback: (token: string) => void) => {
    ipcRenderer.on('popout:authToken', (_event, token: string) => callback(token))
  },

  platform: process.platform,
})

declare global {
  interface Window {
    electronAPI: {
      connect: (url: string) => Promise<{ success: boolean; url: string }>
      getConfig: () => Promise<{ defaultUrl: string; theme: string }>
      openExternal: (url: string) => Promise<void>
      trustHost: (hostname: string) => Promise<{ trusted: boolean; hostname: string }>
      saveToken: (token: string) => Promise<{ saved: boolean }>
      getToken: () => Promise<string>
      isEncryptionAvailable: () => Promise<boolean>
      showNotification: (title: string, body: string) => Promise<void>
      openSubagentPopout: (params: { sessionKey: string; serverUrl: string; authToken: string; authMode: string; label: string }) => Promise<void>
      openToolCallPopout: (params: { toolCallId: string; name: string }) => Promise<void>
      fetchUrl: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<string>
      clawhubInstall: (slug: string, targetDir: string) => Promise<{ ok: boolean; files: string[] }>
      generateEd25519KeyPair: () => Promise<{ id: string; publicKeyBase64url: string; privateKeyJwk: JsonWebKey }>
      signEd25519: (privateKeyJwk: JsonWebKey, payload: string) => Promise<string>
      clipboardRead: () => Promise<string>
      clipboardWrite: (text: string) => Promise<void>
      getDeviceStatus: () => Promise<{ platform: string; arch: string; hostname: string; memory: { total: number; free: number }; uptime: number }>

      // Speech
      speechRecognize: (timeoutSec?: number) => Promise<{ text: string; error?: string }>
      speechStop: () => Promise<void>
      speechAvailable: () => Promise<boolean>
      logForward: (level: string, category: string, message: string, data?: string) => void
      getLogFilePath: () => Promise<string>
      speechCapabilities: () => Promise<{
        stt: boolean; wake: boolean; tts: boolean
        recorder: string | null; whisperBinary: string | null; streamBinary: string | null
        modelPath: string | null; gpu: boolean; setupInstructions: string[]
      }>

      // Wake
      wakeStart: (triggers: string[]) => Promise<boolean>
      wakeStop: () => Promise<void>
      wakeUpdateTriggers: (triggers: string[]) => Promise<void>
      onWakeDetected: (cb: (data: { trigger: string; text: string; fullText: string; action: string }) => void) => void

      // Voice Assistant
      vaStart: () => Promise<boolean>
      vaStop: () => Promise<void>
      vaConfigure: (cfg: { wakeTriggers?: string[]; silenceTimeoutMs?: number; recordTimeoutMs?: number }) => Promise<void>
      vaNotifySpeaking: () => Promise<void>
      vaNotifySpeakingDone: () => Promise<void>
      vaNotifyWaiting: () => Promise<void>
      onVAPhase: (cb: (phase: string) => void) => void
      onVATranscript: (cb: (text: string) => void) => void
      onVAStarted: (cb: () => void) => void
      onVAStopped: (cb: () => void) => void
      onVAError: (cb: (msg: string) => void) => void
      onHotkeyToggle: (cb: () => void) => void
      onPartialTranscript: (cb: (text: string) => void) => void
      onDictationResult: (cb: (data: { text: string }) => void) => void

      onPopoutAuthToken: (callback: (token: string) => void) => void
      platform: NodeJS.Platform
    }
  }
}
