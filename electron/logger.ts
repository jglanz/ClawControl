import { app } from 'electron'
import { join } from 'path'
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, WriteStream } from 'fs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogCategory =
  | 'app'
  | 'ipc'
  | 'speech'
  | 'speech:child'
  | 'wake'
  | 'voice'
  | 'window'
  | 'net'
  | 'crypto'
  | 'clawhub'
  | 'renderer'
  | string

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10 MB rotate threshold

let logStream: WriteStream | null = null
let logFilePath = ''
let minLevel: LogLevel = 'debug'

function getLogDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function rotateIfNeeded(): void {
  if (!logFilePath || !existsSync(logFilePath)) return
  try {
    const stats = statSync(logFilePath)
    if (stats.size >= MAX_LOG_SIZE) {
      const rotated = logFilePath.replace(/\.log$/, `.${Date.now()}.log`)
      logStream?.end()
      logStream = null
      renameSync(logFilePath, rotated)
      logStream = createWriteStream(logFilePath, { flags: 'a' })
    }
  } catch {
    // ignore rotation errors
  }
}

export function initLogger(level?: LogLevel): void {
  if (level) minLevel = level
  const dir = getLogDir()
  logFilePath = join(dir, 'clawcontrol.log')
  logStream = createWriteStream(logFilePath, { flags: 'a' })

  const banner = `\n${'='.repeat(80)}\n[${new Date().toISOString()}] ClawControl logger started (pid=${process.pid}, platform=${process.platform}, arch=${process.arch})\n${'='.repeat(80)}\n`
  logStream.write(banner)
  process.stdout.write(banner)
}

export function getLogFilePath(): string {
  return logFilePath
}

function formatLine(level: LogLevel, category: LogCategory, message: string, data?: unknown): string {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${category}]`
  let line = `${prefix} ${message}`
  if (data !== undefined) {
    try {
      const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      line += ` ${serialized}`
    } catch {
      line += ` [unserializable data]`
    }
  }
  return line
}

function write(level: LogLevel, category: LogCategory, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const line = formatLine(level, category, message, data)

  // Write to file
  if (logStream) {
    logStream.write(line + '\n')
    rotateIfNeeded()
  }

  // Write to stdout/stderr
  if (level === 'error') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

/** Create a category-scoped logger */
export function createLogger(category: LogCategory) {
  return {
    debug: (msg: string, data?: unknown) => write('debug', category, msg, data),
    info: (msg: string, data?: unknown) => write('info', category, msg, data),
    warn: (msg: string, data?: unknown) => write('warn', category, msg, data),
    error: (msg: string, data?: unknown) => write('error', category, msg, data),
    /** Log child process stdout chunk */
    childStdout: (label: string, chunk: Buffer | string) => {
      const text = chunk.toString().trimEnd()
      if (text) write('debug', category, `[${label}:stdout] ${text}`)
    },
    /** Log child process stderr chunk */
    childStderr: (label: string, chunk: Buffer | string) => {
      const text = chunk.toString().trimEnd()
      if (text) write('warn', category, `[${label}:stderr] ${text}`)
    },
  }
}

/** Log an entry forwarded from the renderer process */
export function logFromRenderer(level: LogLevel, category: string, message: string, data?: unknown): void {
  write(level, `renderer:${category}` as LogCategory, message, data)
}
