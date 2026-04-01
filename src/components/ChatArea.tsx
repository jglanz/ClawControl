import { useRef, useEffect, useMemo, useState, useCallback, Fragment, memo, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, selectIsStreaming, selectHadStreamChunks, selectActiveToolCalls, selectStreamingThinking, selectIsCompacting, ToolCall, SubagentInfo } from '../store'
import type { ExecApprovalDecision } from '../lib/openclaw'
import { Message, stripAnsi } from '../lib/openclaw'
import { resolveToolDisplay, extractToolDetail } from '../lib/openclaw/tool-display'
import { openExternal } from '../lib/platform'
import { playBase64Audio } from '../lib/audio-playback'
import { ToolIcon } from './ToolIcon'
import { SubagentBlock } from './SubagentBlock'
import { format, isSameDay } from 'date-fns'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import logoUrl from '../../build/icon.png'

// Configure marked for chat-friendly rendering: single newlines become <br>,
// GFM tables/strikethrough enabled, synchronous parsing.
marked.setOptions({ breaks: true, gfm: true, async: false })

const robotSvgPath = 'M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2zm-4 12a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm8 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z'

/** Agent avatar with fallback to robot SVG on load error */
function AgentAvatarImg({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d={robotSvgPath} />
      </svg>
    )
  }
  return <img src={src} alt={alt} onError={() => setFailed(true)} />
}

export function ChatArea() {
  const { messages: allMessages, agents, currentAgentId, sessions, currentSessionId, activeSubagents, openSubagentPopout, openToolCallPopout, setDraftMessage, pendingExecApprovals, resolveExecApproval } = useStore(useShallow(state => ({
    messages: state.messages,
    agents: state.agents,
    currentAgentId: state.currentAgentId,
    sessions: state.sessions,
    currentSessionId: state.currentSessionId,
    activeSubagents: state.activeSubagents,
    openSubagentPopout: state.openSubagentPopout,
    openToolCallPopout: state.openToolCallPopout,
    setDraftMessage: state.setDraftMessage,
    pendingExecApprovals: state.pendingExecApprovals,
    resolveExecApproval: state.resolveExecApproval,
  })))
  const isStreaming = useStore(selectIsStreaming)
  const hadStreamChunks = useStore(selectHadStreamChunks)
  const activeToolCalls = useStore(selectActiveToolCalls)
  const streamingThinking = useStore(selectStreamingThinking)
  const isCompacting = useStore(selectIsCompacting)
  const sideResult = useStore((state) => state.sideResult)
  const dismissSideResult = useStore((state) => state.dismissSideResult)
  const ttsAutoPlay = useStore((state) => state.ttsAutoPlay)
  const voiceAssistantActive = useStore((state) => state.voiceAssistantActive)
  const client = useStore((state) => state.client)
  const messages = useMemo(() => {
    const seen = new Set<string>()
    return allMessages.filter((m) => {
      if (m.role === 'system' && !m.id.startsWith('error-')) return false
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
  }, [allMessages])
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  // Track session switches so we can instant-scroll when history loads
  const prevSessionRef = useRef(currentSessionId)
  const needsInstantScroll = useRef(true)
  // Sticky scroll: only auto-scroll if user is near bottom
  const isAtBottom = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  // In-chat search
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIndex, setSearchMatchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Count unread messages below viewport for scroll-to-bottom badge
  const [unreadBelow, setUnreadBelow] = useState(0)
  const lastSeenCountRef = useRef(0)

  // Resolve agent from the current session's agentId (e.g. from key "agent:jerry:...")
  // so each chat shows the correct agent name/avatar, not just the globally selected one.
  const currentSession = sessions.find(s => (s.key || s.id) === currentSessionId)
  const sessionAgentId = currentSession?.agentId || currentAgentId
  const currentAgent = agents.find((a) => a.id === sessionAgentId)

  // Build lookup maps: tool calls and subagents grouped by afterMessageId
  // Must be before the early return to satisfy Rules of Hooks.
  const toolCallsByMessageId = useMemo(() => {
    const map = new Map<string, ToolCall[]>()
    for (const tc of activeToolCalls) {
      const key = tc.afterMessageId || '__trailing__'
      const list = map.get(key)
      if (list) list.push(tc)
      else map.set(key, [tc])
    }
    return map
  }, [activeToolCalls])

  const subagentsByMessageId = useMemo(() => {
    const map = new Map<string, SubagentInfo[]>()
    for (const sa of activeSubagents) {
      // Only show subagents belonging to this session
      if (sa.parentSessionId && sa.parentSessionId !== currentSessionId) continue
      const key = sa.afterMessageId || '__trailing__'
      const list = map.get(key)
      if (list) list.push(sa)
      else map.set(key, [sa])
    }
    return map
  }, [activeSubagents, currentSessionId])

  // Auto-play TTS for assistant responses (when ttsAutoPlay enabled and not in VA mode)
  const lastTtsMessageIdRef = useRef('')
  useEffect(() => {
    if (!ttsAutoPlay || !client || voiceAssistantActive || isStreaming) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || last.id === lastTtsMessageIdRef.current) return
    lastTtsMessageIdRef.current = last.id || ''
    if (!last.content?.trim()) return
    void (async () => {
      try {
        const result = await client.talkSpeak({ text: last.content })
        if (result?.audioBase64) playBase64Audio(result.audioBase64, result.mimeType || 'audio/mpeg')
      } catch (err) { console.warn('[ChatArea] TTS auto-play failed:', err) }
    })()
  }, [messages, isStreaming, ttsAutoPlay, voiceAssistantActive, client])

  // Mark session switches so the next render with messages jumps instantly
  useEffect(() => {
    if (prevSessionRef.current !== currentSessionId) {
      prevSessionRef.current = currentSessionId
      needsInstantScroll.current = true
      isAtBottom.current = true
      setShowScrollToBottom(false)
      // Reset unread tracking for the new session
      setUnreadBelow(0)
      lastSeenCountRef.current = messages.length
    }
  }, [currentSessionId, messages.length])

  // Track scroll position to determine if user is near bottom
  useEffect(() => {
    const container = chatContainerRef.current
    if (!container) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const atBottom = distanceFromBottom < 100
      isAtBottom.current = atBottom
      setShowScrollToBottom(!atBottom)
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  // Scroll to bottom: instant on history load, smooth for incremental updates.
  // Only auto-scroll if user is near bottom (sticky scroll).
  useEffect(() => {
    if (messages.length === 0) return
    if (needsInstantScroll.current) {
      needsInstantScroll.current = false
      chatEndRef.current?.scrollIntoView({ behavior: 'instant' })
      return
    }
    if (isAtBottom.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, activeToolCalls, activeSubagents])

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    isAtBottom.current = true
    setShowScrollToBottom(false)
    setUnreadBelow(0)
    lastSeenCountRef.current = messages.length
  }, [messages.length])

  // Track new messages arriving while scrolled up
  useEffect(() => {
    if (isAtBottom.current) {
      lastSeenCountRef.current = messages.length
      setUnreadBelow(0)
    } else if (messages.length > lastSeenCountRef.current) {
      setUnreadBelow(messages.length - lastSeenCountRef.current)
    }
  }, [messages.length])

  // Ctrl+F / Cmd+F to open search
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 50)
      }
      if (e.key === 'Escape' && searchOpenRef.current) {
        setSearchOpen(false)
        setSearchQuery('')
        setSearchMatchIndex(0)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Search match computation
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return []
    const q = searchQuery.toLowerCase()
    return messages
      .map((m, i) => ({ index: i, id: m.id }))
      .filter(({ index }) => messages[index].content.toLowerCase().includes(q))
  }, [messages, searchQuery])

  const navigateSearch = useCallback((direction: 'next' | 'prev') => {
    if (searchMatches.length === 0) return
    const newIdx = direction === 'next'
      ? (searchMatchIndex + 1) % searchMatches.length
      : (searchMatchIndex - 1 + searchMatches.length) % searchMatches.length
    setSearchMatchIndex(newIdx)
    const msgId = searchMatches[newIdx]?.id
    if (msgId) {
      const el = document.querySelector(`[data-testid="message-${msgId}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [searchMatches, searchMatchIndex])

  // Track loading state for session switches
  const [loadingSession, setLoadingSession] = useState(false)
  useEffect(() => {
    if (prevSessionRef.current !== currentSessionId) {
      setLoadingSession(true)
      const timer = setTimeout(() => setLoadingSession(false), 100)
      return () => clearTimeout(timer)
    }
  }, [currentSessionId])
  useEffect(() => {
    if (messages.length > 0) setLoadingSession(false)
  }, [messages.length])

  // Auto-dismiss BTW side result after 15 seconds, or on Escape key
  useEffect(() => {
    if (!sideResult) return
    const timer = setTimeout(dismissSideResult, 15000)
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissSideResult()
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', handleKey)
    }
  }, [sideResult, dismissSideResult])

  if (messages.length === 0) {
    // Show skeleton when switching to a session that should have messages
    if (loadingSession && currentSessionId) {
      return (
        <div className="chat-area" data-testid="chat-area">
          <div className="chat-loading-skeleton">
            <div className="skeleton-message agent"><div className="skeleton-avatar" /><div className="skeleton-lines"><div className="skeleton-line" style={{ width: '70%' }} /><div className="skeleton-line" style={{ width: '50%' }} /></div></div>
            <div className="skeleton-message user"><div className="skeleton-lines right"><div className="skeleton-line" style={{ width: '40%' }} /></div><div className="skeleton-avatar" /></div>
            <div className="skeleton-message agent"><div className="skeleton-avatar" /><div className="skeleton-lines"><div className="skeleton-line" style={{ width: '85%' }} /><div className="skeleton-line" style={{ width: '60%' }} /><div className="skeleton-line" style={{ width: '30%' }} /></div></div>
          </div>
        </div>
      )
    }
    return (
      <div className="chat-area" data-testid="chat-area">
        <div className="chat-empty">
          <div className="empty-logo">
            <img src={logoUrl} alt="ClawControl logo" />
          </div>
          <h2>Start a Conversation</h2>
          <p>Send a message to begin chatting with {currentAgent?.name || 'the AI assistant'}</p>
          <div className="quick-actions">
            <button className="quick-action" onClick={() => setDraftMessage('Explain the concept of ')}>
              <span>Explain a concept</span>
            </button>
            <button className="quick-action" onClick={() => setDraftMessage('Help me write code that ')}>
              <span>Help me code</span>
            </button>
            <button className="quick-action" onClick={() => setDraftMessage('Analyze the following data: ')}>
              <span>Analyze data</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-area" data-testid="chat-area" ref={chatContainerRef}>
      <div className="chat-container">
        {messages.map((message, index) => {
          const isNewDay = index === 0 || !isSameDay(new Date(message.timestamp), new Date(messages[index - 1].timestamp))
          const msgToolCalls = toolCallsByMessageId.get(message.id)
          const msgSubagents = subagentsByMessageId.get(message.id)

          return (
            <Fragment key={message.id}>
              {isNewDay && <DateSeparator date={new Date(message.timestamp)} />}
              {msgToolCalls && msgToolCalls.length > 0 && openToolCallPopout && (
                <ToolCallBubble
                  toolCalls={msgToolCalls}
                  agentAvatar={currentAgent?.avatar}
                  agentName={currentAgent?.name}
                  onOpenPopout={openToolCallPopout}
                />
              )}
              <MessageBubble
                message={message}
                agentName={currentAgent?.name}
                agentAvatar={currentAgent?.avatar}
                streamingThinking={index === messages.length - 1 && isStreaming && !message.thinking ? streamingThinking : undefined}
              />
              {msgSubagents && (
                <div className="subagents-container">
                  {msgSubagents.map((sa) => (
                    <SubagentBlock key={sa.sessionKey} subagent={sa} onOpen={openSubagentPopout} />
                  ))}
                </div>
              )}
            </Fragment>
          )
        })}

        {/* Trailing tool calls and subagents (no afterMessageId) */}
        {toolCallsByMessageId.has('__trailing__') && openToolCallPopout && (
          <ToolCallBubble
            toolCalls={toolCallsByMessageId.get('__trailing__')!}
            agentAvatar={currentAgent?.avatar}
            agentName={currentAgent?.name}
            onOpenPopout={openToolCallPopout}
          />
        )}
        {subagentsByMessageId.has('__trailing__') && (
          <div className="subagents-container">
            {subagentsByMessageId.get('__trailing__')!.map((sa) => (
              <SubagentBlock key={sa.sessionKey} subagent={sa} onOpen={openSubagentPopout} />
            ))}
          </div>
        )}

        {isCompacting && isStreaming && (
          <div className="message agent compaction-indicator-container">
            <div className="message-avatar">
              {currentAgent?.avatar ? (
                <AgentAvatarImg src={currentAgent.avatar} alt={currentAgent.name || 'Agent'} />
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d={robotSvgPath} />
                </svg>
              )}
            </div>
            <div className="message-content">
              <div className="compaction-indicator">
                <svg className="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span>Compacting context...</span>
              </div>
            </div>
          </div>
        )}

        {isStreaming && !hadStreamChunks && (
          <div className="message agent typing-indicator-container" aria-live="polite" aria-label="Agent is typing">
            <div className="message-avatar">
              {currentAgent?.avatar ? (
                <AgentAvatarImg src={currentAgent.avatar} alt={currentAgent.name || 'Agent'} />
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d={robotSvgPath} />
                </svg>
              )}
            </div>
            <div className="message-content">
              <div className="typing-indicator">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}

        {pendingExecApprovals.length > 0 && (
          <div className="exec-approval-stack">
            {pendingExecApprovals.map((approval) => (
              <ExecApprovalBanner
                key={approval.id}
                approval={approval}
                onResolve={resolveExecApproval}
              />
            ))}
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {showScrollToBottom && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          aria-label={unreadBelow > 0 ? `${unreadBelow} new messages — scroll to bottom` : 'Scroll to bottom'}
          title="Scroll to bottom"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
          {unreadBelow > 0 && (
            <span className="scroll-to-bottom-badge">{unreadBelow}</span>
          )}
        </button>
      )}

      {/* BTW side result overlay (v2026.3.22) */}
      {sideResult && (
        <div className="side-result-overlay" role="status" aria-label="Side question answer">
          <div className="side-result-header">
            <span className="side-result-label">/btw</span>
            <button
              className="side-result-dismiss"
              onClick={dismissSideResult}
              aria-label="Dismiss"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="side-result-body">{sideResult.text}</div>
        </div>
      )}

      {/* In-chat search overlay */}
      {searchOpen && (
        <div className="chat-search-bar" role="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search in conversation..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchMatchIndex(0) }}
            onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                navigateSearch(e.shiftKey ? 'prev' : 'next')
              }
              if (e.key === 'Escape') {
                setSearchOpen(false)
                setSearchQuery('')
                setSearchMatchIndex(0)
              }
            }}
            aria-label="Search messages"
          />
          {searchQuery && (
            <span className="chat-search-count">
              {searchMatches.length > 0 ? `${searchMatchIndex + 1}/${searchMatches.length}` : 'No results'}
            </span>
          )}
          <button className="chat-search-nav" onClick={() => navigateSearch('prev')} aria-label="Previous match" disabled={searchMatches.length === 0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button className="chat-search-nav" onClick={() => navigateSearch('next')} aria-label="Next match" disabled={searchMatches.length === 0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <button
            className="chat-search-close"
            onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchMatchIndex(0) }}
            aria-label="Close search"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}
    </div>
  )
}

function ExecApprovalBanner({
  approval,
  onResolve
}: {
  approval: { id: string; command?: string; args?: string[]; cwd?: string; agent?: string; source?: 'exec' | 'plugin'; hookId?: string; toolName?: string }
  onResolve: (approvalId: string, decision: ExecApprovalDecision) => Promise<void>
}) {
  const [resolving, setResolving] = useState<ExecApprovalDecision | null>(null)

  const handle = useCallback(async (decision: ExecApprovalDecision) => {
    setResolving(decision)
    await onResolve(approval.id, decision)
  }, [approval.id, onResolve])

  const displayCommand = approval.args?.length
    ? `${approval.command} ${approval.args.join(' ')}`
    : approval.command || 'Unknown command'

  return (
    <div className="exec-approval-banner">
      <div className="exec-approval-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>{approval.source === 'plugin' ? 'Plugin Approval Required' : 'Exec Approval Required'}</span>
        {approval.hookId && <span className="exec-approval-agent">{approval.hookId}</span>}
        {approval.agent && !approval.hookId && <span className="exec-approval-agent">{approval.agent}</span>}
      </div>
      <div className="exec-approval-command">
        <code>{displayCommand}</code>
      </div>
      {approval.cwd && (
        <div className="exec-approval-cwd">in {approval.cwd}</div>
      )}
      <div className="exec-approval-actions">
        <button
          className="exec-approval-btn exec-approval-btn--allow"
          onClick={() => handle('allow')}
          disabled={resolving !== null}
        >
          {resolving === 'allow' ? 'Allowing...' : 'Allow'}
        </button>
        <button
          className="exec-approval-btn exec-approval-btn--always"
          onClick={() => handle('allow-always')}
          disabled={resolving !== null}
        >
          {resolving === 'allow-always' ? 'Adding...' : 'Always Allow'}
        </button>
        <button
          className="exec-approval-btn exec-approval-btn--deny"
          onClick={() => handle('deny')}
          disabled={resolving !== null}
        >
          {resolving === 'deny' ? 'Denying...' : 'Deny'}
        </button>
      </div>
    </div>
  )
}

function DateSeparator({ date }: { date: Date }) {
  let dateText = ''
  try {
    dateText = format(date, 'EEEE, MMMM d, yyyy')
  } catch (e) {
    return null
  }

  return (
    <div className="date-separator">
      <span>{dateText}</span>
    </div>
  )
}

/** Audio player that shows an expired message via React state instead of innerHTML */
function AudioPlayer({ audioUrl, audioAsVoice }: { audioUrl: string; audioAsVoice?: boolean }) {
  const [expired, setExpired] = useState(false)
  if (expired) {
    return (
      <div className="message-audio message-audio--expired">
        <span className="audio-expired">Voice message expired</span>
      </div>
    )
  }
  return (
    <div className={`message-audio${audioAsVoice ? ' message-audio--voice' : ''}`}>
      <audio
        controls
        preload="metadata"
        src={audioUrl}
        onError={() => setExpired(true)}
      >
        <a href={audioUrl} target="_blank" rel="noopener">Download audio</a>
      </audio>
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({
  message,
  agentName,
  agentAvatar,
  streamingThinking,
}: {
  message: Message
  agentName?: string
  agentAvatar?: string
  streamingThinking?: string
}) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const time = format(new Date(message.timestamp), 'h:mm a')
  const isPinned = useStore(state => state.isMessagePinned(message.id))
  const togglePin = useStore(state => state.togglePinMessage)
  const sendMessage = useStore(state => state.sendMessage)

  // System messages (slash command results) render as a centered info block
  if (isSystem) {
    const isError = message.id.startsWith('error-')
    const canRetry = isError && message.failedContent
    return (
      <div className={`message system${isError ? ' system-error' : ''}`} data-testid={`message-${message.id}`}>
        <div className="message-content">
          <div className={`message-bubble system-bubble${isError ? ' error-bubble' : ''}`}>
            <MessageContent content={message.content} />
            {canRetry && (
              <button
                className="message-retry-btn"
                onClick={() => sendMessage(message.failedContent!, message.failedAttachments)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0115.36-6.36L21 8" />
                </svg>
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`message ${isUser ? 'user' : 'agent'}${isPinned ? ' pinned' : ''}`} data-testid={`message-${message.id}`}>
      {!isUser && (
        <div className="message-avatar">
          {agentAvatar ? (
            <AgentAvatarImg src={agentAvatar} alt={agentName || 'Agent'} />
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d={robotSvgPath} />
            </svg>
          )}
        </div>
      )}

      <div className="message-content">
        <div className="message-header">
          {isUser ? (
            <>
              <span className="message-time">{time}</span>
              <span className="message-author">You</span>
            </>
          ) : (
            <>
              <span className="message-author">{agentName || 'Assistant'}</span>
              <span className="message-time">{time}</span>
            </>
          )}
          <button
            className={`pin-btn${isPinned ? ' pinned' : ''}`}
            onClick={() => togglePin(message.id)}
            title={isPinned ? 'Unpin message' : 'Pin message'}
            aria-label={isPinned ? 'Unpin message' : 'Pin message'}
          >
            <svg viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7l3-7z" />
            </svg>
          </button>
        </div>
        <div className="message-bubble">
          {(message.thinking || streamingThinking) && (
            <ThinkingBlock
              text={message.thinking || streamingThinking || ''}
              streaming={!!streamingThinking && !message.thinking}
            />
          )}
          <MessageContent content={message.content} images={message.images} audioUrl={message.audioUrl} videoUrl={message.videoUrl} audioAsVoice={message.audioAsVoice} />
        </div>
      </div>

      {isUser && (
        <div className="message-avatar user-avatar">
          <span>You</span>
        </div>
      )}
    </div>
  )
})

/** Collapsible thinking/reasoning block */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [collapsed, setCollapsed] = useState(true)

  return (
    <div className="thinking-block">
      <button
        className="thinking-header"
        onClick={() => setCollapsed(!collapsed)}
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <span>Thinking{streaming ? '' : ' (done)'}</span>
        {streaming && <span className="thinking-pulse" />}
        <svg className={`thinking-chevron${collapsed ? '' : ' thinking-chevron--open'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {!collapsed && (
        <div className="thinking-content">{text}</div>
      )}
    </div>
  )
}

/** Renders a group of tool calls in their own agent-style bubble */
function ToolCallBubble({ toolCalls, agentAvatar, agentName, onOpenPopout }: {
  toolCalls: ToolCall[]
  agentAvatar?: string
  agentName?: string
  onOpenPopout: (id: string) => void
}) {
  return (
    <div className="message agent tool-call-bubble">
      <div className="message-avatar">
        {agentAvatar ? (
          <AgentAvatarImg src={agentAvatar} alt={agentName || 'Agent'} />
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d={robotSvgPath} />
          </svg>
        )}
      </div>
      <div className="message-content">
        <div className="message-bubble">
          {toolCalls.map((tc) => (
            <ToolCallBlock key={tc.toolCallId} toolCall={tc} onOpenPopout={onOpenPopout} />
          ))}
        </div>
      </div>
    </div>
  )
}

const TOOL_INLINE_THRESHOLD = 80
const TOOL_PREVIEW_MAX = 100

function getTruncatedPreview(text: string): string {
  const lines = text.split('\n')
  const preview = lines.slice(0, 2).join('\n')
  if (preview.length > TOOL_PREVIEW_MAX) return preview.slice(0, TOOL_PREVIEW_MAX) + '\u2026'
  if (lines.length > 2) return preview + '\u2026'
  return preview
}

function ToolCallBlock({ toolCall, onOpenPopout }: { toolCall: ToolCall; onOpenPopout: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = toolCall.phase === 'start'
  const display = resolveToolDisplay(toolCall.name)
  const detail = extractToolDetail(toolCall.args, display.detailKeys)
  const resultText = toolCall.result ? stripAnsi(toolCall.result).trim() : ''
  const hasText = resultText.length > 0
  const isShort = hasText && resultText.length <= TOOL_INLINE_THRESHOLD
  const showCollapsed = hasText && !isShort && !expanded
  const showInline = hasText && isShort && !expanded
  const isEmpty = !hasText && !isRunning
  const hasArgs = toolCall.args && Object.keys(toolCall.args).length > 0

  const canClick = (hasText || hasArgs || isEmpty) && !isRunning
  const handleClick = () => {
    if (hasText || hasArgs) {
      setExpanded(!expanded)
    }
  }
  const handlePopout = (e: React.MouseEvent) => {
    e.stopPropagation()
    onOpenPopout(toolCall.toolCallId)
  }

  return (
    <div
      className={`chat-tool-card${canClick ? ' chat-tool-card--clickable' : ''}${expanded ? ' chat-tool-card--expanded' : ''}`}
      onClick={canClick ? handleClick : undefined}
      role={canClick ? 'button' : undefined}
      tabIndex={canClick ? 0 : undefined}
      onKeyDown={canClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() }
      } : undefined}
    >
      <div className="chat-tool-card__header">
        <div className="chat-tool-card__title">
          <span className="chat-tool-card__icon">
            {isRunning ? (
              <svg className="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <ToolIcon type={display.icon} size={14} />
            )}
          </span>
          <span>{display.title}</span>
        </div>
        {!isRunning && (hasText || hasArgs) && (
          <span className="chat-tool-card__action">
            {expanded ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M18 15l-6-6-6 6" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M6 9l6 6 6-6" /></svg>
            )}
          </span>
        )}
        {isEmpty && !hasArgs && (
          <span className="chat-tool-card__status">
            <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        )}
        {isRunning && (
          <span className="chat-tool-card__running-text">Running&hellip;</span>
        )}
      </div>
      {detail && !expanded && <div className="chat-tool-card__detail">{detail}</div>}
      {isEmpty && !hasArgs && <div className="chat-tool-card__status-text muted">Completed</div>}
      {isRunning && <div className="chat-tool-card__status-text muted">In progress&hellip;</div>}
      {showCollapsed && (
        <div className="chat-tool-card__preview mono">{getTruncatedPreview(resultText)}</div>
      )}
      {showInline && (
        <div className="chat-tool-card__inline mono">{resultText}</div>
      )}
      {expanded && (
        <div className="chat-tool-card__expanded-detail">
          {hasArgs && (
            <div className="chat-tool-card__args">
              <div className="chat-tool-card__section-label muted">Input</div>
              <pre className="chat-tool-card__args-content mono">{formatToolArgs(toolCall.args!)}</pre>
            </div>
          )}
          {hasText && (
            <div className="chat-tool-card__result">
              <div className="chat-tool-card__section-label muted">Output</div>
              <pre className="chat-tool-card__result-content mono">{resultText}</pre>
            </div>
          )}
          {!hasText && !hasArgs && (
            <div className="chat-tool-card__status-text muted">No output captured</div>
          )}
          {hasText && (
            <button className="chat-tool-card__popout-btn" onClick={handlePopout} title="Open in new window">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              </svg>
              <span>Open in window</span>
            </button>
          )}
        </div>
      )}
      <CanvasToolExtras toolCall={toolCall} />
    </div>
  )
}

/** Format tool call arguments for display */
function formatToolArgs(args: Record<string, unknown>): string {
  // Filter out internal keys
  const filtered = Object.entries(args).filter(([k]) => !k.startsWith('_'))
  if (filtered.length === 0) return JSON.stringify(args, null, 2)
  // For single-value args, show just the value
  if (filtered.length === 1) {
    const [key, value] = filtered[0]
    if (typeof value === 'string') return `${key}: ${value}`
  }
  return filtered.map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v)
    return `${k}: ${val}`
  }).join('\n')
}

/** Extra UI for canvas tool calls: Show Canvas button for present, inline image for snapshot. */
function CanvasToolExtras({ toolCall }: { toolCall: ToolCall }) {
  if (toolCall.name !== 'canvas') return null
  const action = toolCall.args?.action as string | undefined

  // "Show Canvas" button for present actions
  if (action === 'present' && toolCall.phase !== 'start') {
    const handleShowCanvas = (e: React.MouseEvent) => {
      e.stopPropagation()
      const state = useStore.getState()
      if (state.canvasHostUrl) {
        state.setCanvasVisible(true)
      }
    }
    return (
      <button className="canvas-show-btn" onClick={handleShowCanvas}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
        Show Canvas
      </button>
    )
  }

  // Inline image preview for snapshot results with base64 data
  if (action === 'snapshot' && toolCall.result) {
    const result = toolCall.result.trim()
    // Check if result contains base64 image data
    const b64Match = result.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/)
    if (b64Match) {
      return (
        <div className="canvas-snapshot-preview">
          <img src={b64Match[0]} alt="Canvas snapshot" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 4 }} />
        </div>
      )
    }
  }

  return null
}

/**
 * Convert a data: URI to a Blob URL for more reliable rendering in Electron/Chromium.
 * Large data URIs can fail to render as img src; Blob URLs bypass this limitation.
 */
function dataUriToBlobUrl(dataUri: string): string | null {
  try {
    const match = dataUri.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/)
    if (!match) return null
    const mime = match[1] || 'image/png'
    const b64 = match[2]
    const bytes = atob(b64)
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    return URL.createObjectURL(new Blob([arr], { type: mime }))
  } catch {
    return null
  }
}

/** Detect whether a URL points to a gateway /media/ endpoint that needs auth.
 *  Validates both the path AND the origin to prevent sending auth tokens to untrusted hosts. */
function isGatewayMediaUrl(url: string, serverUrl: string): boolean {
  try {
    const u = new URL(url)
    if (!u.pathname.startsWith('/media/')) return false
    // Verify origin matches the configured server
    if (!serverUrl) return false
    const server = new URL(serverUrl)
    // Compare host (ignoring ws/wss vs http/https protocol difference)
    return u.host === server.host
  } catch {
    return false
  }
}

function ChatImage({ url, alt }: { url: string; alt?: string }) {
  const [error, setError] = useState(false)
  // Track whether we already tried falling back from blob URL to data URI
  const [blobFailed, setBlobFailed] = useState(false)
  // Auth-fetched blob URL for gateway /media/ paths
  const [authBlobUrl, setAuthBlobUrl] = useState<string | null>(null)
  const gatewayToken = useStore(state => state.gatewayToken)
  const serverUrl = useStore(state => state.serverUrl)
  const isGatewayMedia = isGatewayMediaUrl(url, serverUrl)

  const blobUrl = useMemo(() => {
    if (url.startsWith('data:')) return dataUriToBlobUrl(url)
    return null
  }, [url])

  // Revoke blob URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [blobUrl])

  // Fetch gateway /media/ URLs with auth token.
  // Reset state when url/token changes to avoid showing stale blobs.
  useEffect(() => {
    if (!isGatewayMedia) {
      setAuthBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
      return
    }
    // Reset for new fetch
    setError(false)
    setAuthBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })

    const controller = new AbortController()
    const headers: Record<string, string> = {}
    if (gatewayToken) {
      headers['Authorization'] = `Bearer ${gatewayToken}`
    }
    fetch(url, { headers, signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.blob()
      })
      .then(b => {
        if (!controller.signal.aborted) {
          setAuthBlobUrl(URL.createObjectURL(b))
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => {
      controller.abort()
    }
  }, [url, gatewayToken, isGatewayMedia])

  // Clean up auth blob URL on unmount
  useEffect(() => {
    return () => {
      if (authBlobUrl) URL.revokeObjectURL(authBlobUrl)
    }
  }, [authBlobUrl])

  // Determine the src to use:
  // - Gateway media URLs: use auth-fetched blob
  // - Data URIs: use converted blob (or original as fallback)
  // - Everything else: use URL directly
  let src: string
  if (isGatewayMedia) {
    if (authBlobUrl) {
      src = authBlobUrl
    } else {
      // Still loading — show nothing until fetch completes (or errors)
      if (!error) {
        return (
          <div className="image-loading-placeholder">
            <svg className="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
        )
      }
      src = url
    }
  } else {
    src = (blobUrl && !blobFailed) ? blobUrl : url
  }

  if (error) {
    // For data: URIs, a link is useless — show an inline error placeholder.
    // For http(s) URLs, show a clickable link to open in browser.
    if (url.startsWith('data:')) {
      return <div className="message-image-fallback">{'\uD83D\uDDBC\uFE0F'} {alt || 'Image'} (failed to load)</div>
    }
    return (
      <a href={url} target="_blank" rel="noopener" className="message-image-fallback"
        onClick={(e) => { e.preventDefault(); void openExternal(url) }}>
        {'\uD83D\uDDBC\uFE0F'} {alt || 'Image'}
      </a>
    )
  }

  return (
    <img
      className="message-image"
      src={src}
      alt={alt || 'Attached image'}
      loading="lazy"
      onError={() => {
        // If a blob URL failed, fall back to the original data URI before giving up
        if (blobUrl && !blobFailed) {
          setBlobFailed(true)
        } else {
          setError(true)
        }
      }}
    />
  )
}

function ChatVideo({ url }: { url: string }) {
  const [error, setError] = useState(false)
  const [authBlobUrl, setAuthBlobUrl] = useState<string | null>(null)
  const gatewayToken = useStore(state => state.gatewayToken)
  const serverUrl = useStore(state => state.serverUrl)
  const isGatewayMedia = isGatewayMediaUrl(url, serverUrl)

  useEffect(() => {
    if (!isGatewayMedia) return
    setError(false)
    setAuthBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })

    const controller = new AbortController()
    const headers: Record<string, string> = {}
    if (gatewayToken) {
      headers['Authorization'] = `Bearer ${gatewayToken}`
    }
    fetch(url, { headers, signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.blob()
      })
      .then(b => {
        if (!controller.signal.aborted) {
          setAuthBlobUrl(URL.createObjectURL(b))
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => { controller.abort() }
  }, [url, gatewayToken, isGatewayMedia])

  useEffect(() => {
    return () => { if (authBlobUrl) URL.revokeObjectURL(authBlobUrl) }
  }, [authBlobUrl])

  const src = isGatewayMedia ? (authBlobUrl || url) : url

  if (isGatewayMedia && !authBlobUrl && !error) {
    return (
      <div className="image-loading-placeholder">
        <svg className="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </div>
    )
  }

  if (error) {
    return (
      <a href={url} target="_blank" rel="noopener" className="message-image-fallback"
        onClick={(e) => { e.preventDefault(); void openExternal(url) }}>
        {'\uD83C\uDFA5'} Video (failed to load)
      </a>
    )
  }

  return (
    <div className="message-video">
      <video
        controls
        preload="metadata"
        src={src}
        onError={() => setError(true)}
      >
        <a href={url} target="_blank" rel="noopener">Download video</a>
      </video>
    </div>
  )
}

// Custom marked renderer that wraps fenced code blocks with a copy button
const renderer = new marked.Renderer()
const originalCode = renderer.code.bind(renderer)
renderer.code = function (this: unknown, ...args: Parameters<typeof originalCode>) {
  const html = originalCode.apply(this, args)
  return `<div class="code-block-wrapper"><button class="code-copy-btn" type="button" aria-label="Copy code"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>${html}</div>`
}

function MessageContent({ content, images, audioUrl, videoUrl, audioAsVoice }: { content: string; images?: Message['images']; audioUrl?: string; videoUrl?: string; audioAsVoice?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const hasImagePlaceholder = content.includes('[__IMAGE_LOADING__]')
  const displayContent = hasImagePlaceholder
    ? content.replace(/\[__IMAGE_LOADING__\]/g, '').trim()
    : content
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(stripAnsi(displayContent), { async: false, renderer }) as string),
    [displayContent]
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement

      // External link handling: force http(s) links to OS default browser.
      const anchor = target.closest('a') as HTMLAnchorElement | null
      if (anchor) {
        const href = anchor.getAttribute('href') || ''
        const isExternal = /^(https?:\/\/|mailto:|tel:)/i.test(href)
        if (isExternal) {
          e.preventDefault()
          e.stopPropagation()
          void openExternal(href)
          return
        }
        // Allow internal routes (e.g. /foo) and other protocols to behave normally.
      }

      // Copy button handling for fenced code blocks
      const btn = target.closest('.code-copy-btn')
      if (!btn) return
      const wrapper = btn.closest('.code-block-wrapper')
      const code = wrapper?.querySelector('code')
      if (!code) return
      navigator.clipboard.writeText(code.textContent || '').then(() => {
        btn.classList.add('copied')
        setTimeout(() => btn.classList.remove('copied'), 2000)
      })
    }

    el.addEventListener('click', handler)
    return () => el.removeEventListener('click', handler)
  }, [html])

  return (
    <div>
      {displayContent && <div className="markdown-content" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />}
      {hasImagePlaceholder && !images?.length && (
        <div className="image-loading-placeholder">
          <svg className="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <span>Generating image...</span>
        </div>
      )}
      {images && images.length > 0 && (
        <div className="message-images">
          {images.map((img, idx) => (
            <ChatImage key={`${img.url.slice(0, 80)}-${idx}`} url={img.url} alt={img.alt} />
          ))}
        </div>
      )}
      {audioUrl && (
        <AudioPlayer audioUrl={audioUrl} audioAsVoice={audioAsVoice} />
      )}
      {videoUrl && (
        <ChatVideo url={videoUrl} />
      )}
    </div>
  )
}
