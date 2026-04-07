/**
 * Central logger for the renderer process.
 * Logs to the browser console with structured prefixes, and forwards
 * all entries to the main process (via IPC) for file-based persistence.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogCategory =
  | 'voice'
  | 'wake'
  | 'dictation'
  | 'speech'
  | 'store'
  | 'client'
  | 'ui'
  | string

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
let minLevel: LogLevel = 'debug'

function ts(): string {
  return new Date().toISOString()
}

function forward(level: LogLevel, category: string, message: string, data?: unknown): void {
  try {
    const api = (window as any).electronAPI
    if (api?.logForward) {
      api.logForward(level, category, message, data !== undefined ? serialize(data) : undefined)
    }
  } catch {
    // IPC not available (web/mobile) — console-only is fine
  }
}

function serialize(data: unknown): string | undefined {
  if (data === undefined) return undefined
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return '[unserializable]'
  }
}

function write(level: LogLevel, category: LogCategory, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const prefix = `[${ts()}] [${category}]`
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log

  if (data !== undefined) {
    consoleFn(prefix, message, data)
  } else {
    consoleFn(prefix, message)
  }

  forward(level, category, message, data)
}

/** Create a category-scoped logger for renderer code */
export function createLogger(category: LogCategory) {
  return {
    debug: (msg: string, data?: unknown) => write('debug', category, msg, data),
    info: (msg: string, data?: unknown) => write('info', category, msg, data),
    warn: (msg: string, data?: unknown) => write('warn', category, msg, data),
    error: (msg: string, data?: unknown) => write('error', category, msg, data),
  }
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}
