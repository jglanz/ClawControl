import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const DEFAULTS: WindowState = { width: 1400, height: 900 }

function getPath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

export function loadWindowState(): WindowState {
  try {
    const p = getPath()
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf-8'))
      if (data.width >= 800 && data.height >= 600) return data
    }
  } catch { /* use defaults */ }
  return DEFAULTS
}

export function saveWindowState(state: WindowState): void {
  try {
    writeFileSync(getPath(), JSON.stringify(state, null, 2))
  } catch { /* ignore */ }
}
