import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import { getPlatform } from '../lib/platform'

const SHORTCUT_LABELS: Record<string, string> = {
  voiceAssistant: 'Toggle Voice Assistant',
  focusInput: 'Focus App & Input',
}

function eventToAccelerator(e: KeyboardEvent): string | null {
  const key = e.key
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return null

  const parts: string[] = []
  if (e.metaKey) parts.push('Super')
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  if (parts.length === 0) return null

  const keyName = key.length === 1 ? key.toUpperCase() : key
  parts.push(keyName)
  return parts.join('+')
}

function KeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const accel = eventToAccelerator(e)
    if (accel) {
      onChange(accel)
      setRecording(false)
    }
  }, [onChange])

  useEffect(() => {
    if (!recording) return
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, handleKeyDown])

  return (
    <button
      className={`key-recorder${recording ? ' recording' : ''}`}
      onClick={() => setRecording(!recording)}
      onBlur={() => setRecording(false)}
    >
      {recording ? 'Press keys...' : value || 'Click to set'}
    </button>
  )
}

export function ShortcutEditor() {
  const { shortcuts, setShortcut } = useStore()
  const api = (window as any).electronAPI

  if (getPlatform() !== 'electron') return null

  const handleChange = (action: string, accelerator: string) => {
    setShortcut(action, accelerator)
    const updated = { ...useStore.getState().shortcuts, [action]: accelerator }
    api?.updateShortcuts?.(updated)
  }

  return (
    <div className="shortcut-editor">
      <h3>Keyboard Shortcuts</h3>
      <div className="shortcut-list">
        {Object.entries(SHORTCUT_LABELS).map(([action, label]) => (
          <div key={action} className="shortcut-row">
            <span className="shortcut-label">{label}</span>
            <KeyRecorder
              value={shortcuts[action] || ''}
              onChange={(accel) => handleChange(action, accel)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
