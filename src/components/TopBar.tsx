import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, selectSessionFastMode, selectSessionThinkingLevel } from '../store'

export function TopBar() {
  const {
    setSidebarOpen,
    toggleTheme,
    rightPanelOpen,
    setRightPanelOpen,
    thinkingEnabled,
    setThinkingEnabled,
    fastModeEnabled,
    setFastModeEnabled,
    sessions,
    agents,
    currentSessionId,
    connected,
    connecting,
    setShowSettings,
    serverProfiles,
    getActiveProfile,
    canvasHostUrl,
    canvasVisible,
    toggleCanvas,
    mainView,
    patchCurrentSession,
    voiceAssistantActive,
    voiceAssistantPhase,
    toggleVoiceAssistant,
  } = useStore(useShallow(state => ({
    setSidebarOpen: state.setSidebarOpen,
    toggleTheme: state.toggleTheme,
    rightPanelOpen: state.rightPanelOpen,
    setRightPanelOpen: state.setRightPanelOpen,
    thinkingEnabled: state.thinkingEnabled,
    setThinkingEnabled: state.setThinkingEnabled,
    fastModeEnabled: state.fastModeEnabled,
    setFastModeEnabled: state.setFastModeEnabled,
    sessions: state.sessions,
    agents: state.agents,
    currentSessionId: state.currentSessionId,
    connected: state.connected,
    connecting: state.connecting,
    setShowSettings: state.setShowSettings,
    serverProfiles: state.serverProfiles,
    getActiveProfile: state.getActiveProfile,
    canvasHostUrl: state.canvasHostUrl,
    canvasVisible: state.canvasVisible,
    toggleCanvas: state.toggleCanvas,
    mainView: state.mainView,
    patchCurrentSession: state.patchCurrentSession,
    voiceAssistantActive: state.voiceAssistantActive,
    voiceAssistantPhase: state.voiceAssistantPhase,
    toggleVoiceAssistant: state.toggleVoiceAssistant,
  })))

  const sessionFastMode = useStore(selectSessionFastMode)
  const sessionThinkingLevel = useStore(selectSessionThinkingLevel)

  const currentSession = sessions.find((s) => (s.key || s.id) === currentSessionId)

  // Resolve a friendly display name, matching the Sidebar logic:
  // 1. If the session has a custom title (not "New Chat" and not the raw key), use it.
  // 2. Otherwise parse agent:name:id from the key and look up the agent's display name.
  const sessionName = useMemo(() => {
    if (!currentSession) return 'New Chat'
    const key = currentSession.key || currentSession.id || ''
    const title = currentSession.title || ''
    const isNewChat = title === 'New Chat'
    const hasCustomTitle = !isNewChat && title && title !== key
    if (hasCustomTitle) return title

    const keyParts = key.match(/^agent:([^:]+):(.+)$/)
    if (keyParts) {
      const agentSlug = keyParts[1]
      const agent = agents.find(a => a.id === currentSession.agentId)
        || agents.find(a => a.id === agentSlug)
      if (agent?.name) return agent.name
      return agentSlug.charAt(0).toUpperCase() + agentSlug.slice(1)
    }
    return title || 'New Chat'
  }, [currentSession, agents])

  return (
    <header className="top-bar" data-testid="top-bar">
      <button
        className="menu-btn"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open menu"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 12h18M3 6h18M3 18h18" />
        </svg>
      </button>

      <div className="session-name" data-testid="session-name">
        <span>{sessionName}</span>
        <button className="edit-btn" aria-label="Edit session name">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      </div>

      <div className="connection-status">
        <span className={`status-dot ${connecting ? 'connecting' : connected ? 'connected' : 'disconnected'}`} />
        <span className="status-text">
          {connecting
            ? 'Connecting...'
            : connected
              ? (serverProfiles.length > 1 ? getActiveProfile()?.name || 'Connected' : 'Connected')
              : 'Disconnected'}
        </span>
      </div>

      <div className="top-bar-actions">
        <div className="thinking-toggle" title={`Thinking mode${sessionThinkingLevel ? ` (${sessionThinkingLevel})` : ''}`}>
          <svg className="thinking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17a1 1 0 001 1h6a1 1 0 001-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7z" />
            <path d="M9 21h6M10 19v2M14 19v2" />
            <path d="M10 9.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5c0 .53-.28 1-.7 1.27-.26.17-.3.23-.3.73" strokeLinecap="round" />
            <circle cx="12" cy="13" r=".5" fill="currentColor" />
          </svg>
          <span className="thinking-label">Thinking</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={thinkingEnabled}
              onChange={(e) => setThinkingEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="thinking-toggle fast-toggle" title={`Fast mode${sessionFastMode ? ' (active)' : ''}`}>
          <svg className="thinking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span className="thinking-label">Fast</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={fastModeEnabled || sessionFastMode}
              onChange={(e) => {
                setFastModeEnabled(e.target.checked)
                patchCurrentSession({ fastMode: e.target.checked || null })
              }}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <button
          className={`panel-toggle va-toggle${voiceAssistantActive ? ' active' : ''}`}
          onClick={toggleVoiceAssistant}
          aria-label={voiceAssistantActive ? 'Stop Voice Assistant' : 'Start Voice Assistant'}
          aria-pressed={voiceAssistantActive}
          title={voiceAssistantActive ? 'Stop Voice Assistant (Super+/)' : 'Start Voice Assistant (Super+/)'}
        >
          <svg viewBox="0 0 24 24" fill={voiceAssistantActive ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
            <path d="M19 11a7 7 0 0 1-14 0" />
            <path d="M12 18v3" />
          </svg>
        </button>

        {voiceAssistantActive && (
          <span className="va-status-badge" data-phase={voiceAssistantPhase}>
            {voiceAssistantPhase === 'listening' ? 'Listening...' :
             voiceAssistantPhase === 'waiting' ? 'Thinking...' :
             voiceAssistantPhase === 'speaking' ? 'Speaking...' :
             voiceAssistantPhase === 'transcribing' ? 'Processing...' : 'VA Active'}
          </span>
        )}

        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          aria-pressed={false}
        >
          <svg className="sun-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          <svg className="moon-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
          </svg>
        </button>

        {canvasHostUrl && mainView === 'chat' && (
          <button
            className={`panel-toggle ${canvasVisible ? 'active' : ''}`}
            onClick={toggleCanvas}
            aria-label="Toggle canvas"
            aria-pressed={canvasVisible}
            title="Toggle canvas"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </button>
        )}

        <button
          className={`panel-toggle ${rightPanelOpen ? 'active' : ''}`}
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
          aria-label="Toggle right panel"
          aria-pressed={rightPanelOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>

        <button className="settings-btn" aria-label="Settings" onClick={() => setShowSettings(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  )
}
