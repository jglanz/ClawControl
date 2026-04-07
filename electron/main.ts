process.setSourceMapsEnabled(true)

import { app, BrowserWindow, ipcMain, shell, Menu, safeStorage, Notification, protocol, net, clipboard } from 'electron'
import { join, resolve, relative } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import crypto from 'crypto'
import os from 'os'
import { initLogger, createLogger, logFromRenderer, getLogFilePath } from './logger'
import { setupSpeechHandlers, cleanupSpeech } from './speech'

const log = createLogger('app')
const speechLog = createLogger('speech')
const childLog = createLogger('speech:child')

// On production builds, serve via a custom protocol scheme to avoid file:// origin issues
const useCustomProtocol = !process.env.VITE_DEV_SERVER_URL

if (useCustomProtocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }])
}

let mainWindow: BrowserWindow | null = null
const trustedHosts = new Set<string>()

// Path to persist trusted hosts
function getTrustedHostsPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'trusted-hosts.json')
}

// Load trusted hosts from disk
function loadTrustedHosts(): void {
  try {
    const filePath = getTrustedHostsPath()
    if (existsSync(filePath)) {
      const data = readFileSync(filePath, 'utf-8')
      const hosts: string[] = JSON.parse(data)
      hosts.forEach(host => trustedHosts.add(host))
    }
  } catch {
    // Ignore errors loading trusted hosts
  }
}

// Save trusted hosts to disk
function saveTrustedHosts(): void {
  try {
    const filePath = getTrustedHostsPath()
    const dir = join(filePath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const hosts = Array.from(trustedHosts)
    writeFileSync(filePath, JSON.stringify(hosts, null, 2))
  } catch {
    // Ignore errors saving trusted hosts
  }
}

function createWindow() {
  // Remove the default menu bar (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    },
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? true : true,
    backgroundColor: '#0d1117'
  })

  // Grant microphone permission for speech recognition
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true)
      return
    }
    callback(false)
  })

  // Allow DevTools shortcuts only in development
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        mainWindow?.webContents.toggleDevTools()
      }
    })
  }

  // Enable context menu for copy/paste
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    ])
    menu.popup()
  })

  // Open external links in the user's default browser / OS handler
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' || u.protocol === 'tel:') {
        shell.openExternal(url)
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the dev server or the app itself
    const appOrigin = process.env.VITE_DEV_SERVER_URL
      ? new URL(process.env.VITE_DEV_SERVER_URL).origin
      : useCustomProtocol ? 'app://localhost' : 'file://'
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
      try {
        const u = new URL(url)
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' || u.protocol === 'tel:') {
          shell.openExternal(url)
        }
      } catch {
        // ignore invalid URLs
      }
    }
  })

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else if (useCustomProtocol) {
    mainWindow.loadURL('app://localhost/')
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}


// Handle certificate errors - trust hosts that user has explicitly accepted
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  try {
    const parsedUrl = new URL(url)
    if (trustedHosts.has(parsedUrl.hostname)) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    // Ignore URL parsing errors
  }
  callback(false)
})

app.whenReady().then(() => {
  initLogger()
  log.info('App ready', { version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData') })

  // Set app identity for Windows notifications (otherwise shows "electron.app.Electron")
  if (process.platform === 'win32') {
    app.setAppUserModelId('ClawControl')
  }

  // Set custom dock icon for macOS
  if (process.platform === 'darwin') {
    app.dock.setIcon(join(__dirname, '../build/icon.png'))
  }

  // Register custom protocol handler for production builds
  if (useCustomProtocol) {
    const distPath = join(__dirname, '../dist')
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
      '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2',
      '.ttf': 'font/ttf', '.ico': 'image/x-icon'
    }
    protocol.handle('app', (request) => {
      const url = new URL(request.url)
      let filePath = decodeURIComponent(url.pathname)
      if (filePath === '/' || filePath === '') filePath = '/index.html'
      const fullPath = resolve(distPath, '.' + filePath)
      // Prevent path traversal — resolved path must stay within distPath
      const rel = relative(distPath, fullPath)
      if (rel.startsWith('..') || resolve(distPath, rel) !== fullPath) {
        return new Response('Not found', { status: 404 })
      }
      const ext = '.' + filePath.split('.').pop()
      const data = readFileSync(fullPath)
      return new Response(data, {
        headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' }
      })
    })
  }

  loadTrustedHosts()
  createWindow()

  // Initialize speech module after window is ready
  if (mainWindow) setupSpeechHandlers(mainWindow)
})

app.on('window-all-closed', () => {
  cleanupSpeech()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Notification handler
ipcMain.handle('notification:show', (_event, title: string, body: string) => {
  new Notification({ title, body }).show()
})

// IPC handlers for OpenClaw communication
ipcMain.handle('openclaw:connect', async (_event, url: string) => {
  // Connection will be handled in renderer process via WebSocket
  return { success: true, url }
})

ipcMain.handle('openclaw:getConfig', async () => {
  return {
    defaultUrl: '',
    theme: 'dark'
  }
})

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  // Validate URL to only allow safe protocols
  try {
    const parsedUrl = new URL(url)
    const allowed = new Set(['http:', 'https:', 'mailto:', 'tel:'])
    if (!allowed.has(parsedUrl.protocol)) {
      throw new Error('Invalid protocol')
    }
    await shell.openExternal(url)
  } catch {
    throw new Error('Invalid URL')
  }
})

// --- Secure token storage ---

function getTokenPath(): string {
  return join(app.getPath('userData'), 'auth-token.enc')
}

function saveToken(token: string): void {
  const filePath = getTokenPath()
  if (!token) {
    // Delete the file when token is cleared
    try { unlinkSync(filePath) } catch { /* file may not exist */ }
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token)
    writeFileSync(filePath, encrypted)
  } else {
    // Fallback: base64 (better than plaintext in localStorage)
    writeFileSync(filePath, Buffer.from(token, 'utf-8').toString('base64'), 'utf-8')
  }
}

function loadToken(): string {
  const filePath = getTokenPath()
  if (!existsSync(filePath)) return ''
  try {
    const raw = readFileSync(filePath)
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(raw)
    }
    // Fallback: base64
    return Buffer.from(raw.toString('utf-8'), 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

ipcMain.handle('auth:saveToken', async (_event, token: string) => {
  if (typeof token !== 'string') throw new Error('Invalid token')
  saveToken(token)
  return { saved: true }
})

ipcMain.handle('auth:getToken', async () => {
  return loadToken()
})

ipcMain.handle('auth:isEncryptionAvailable', async () => {
  return safeStorage.isEncryptionAvailable()
})

// Open a subagent popout window
ipcMain.handle('subagent:openPopout', async (_event, params: {
  sessionKey: string
  serverUrl: string
  authToken: string
  authMode: string
  label: string
}) => {
  // Pass connection details via hash WITHOUT the auth token (security: avoid URL exposure)
  const hash = `#subagent?sessionKey=${encodeURIComponent(params.sessionKey)}&serverUrl=${encodeURIComponent(params.serverUrl)}&authMode=${encodeURIComponent(params.authMode)}`

  const popout = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 500,
    minHeight: 400,
    title: `Subagent: ${params.label}`,
    icon: join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    },
    backgroundColor: '#0d1117'
  })

  // Remove menu bar from popout
  popout.setMenuBarVisibility(false)

  // Open external links in the user's default browser
  popout.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  popout.webContents.on('will-navigate', (event, url) => {
    const appOrigin = process.env.VITE_DEV_SERVER_URL
      ? new URL(process.env.VITE_DEV_SERVER_URL).origin
      : useCustomProtocol ? 'app://localhost' : 'file://'
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
      if (url.startsWith('http:') || url.startsWith('https:')) {
        shell.openExternal(url)
      }
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    popout.loadURL(`${process.env.VITE_DEV_SERVER_URL}${hash}`)
  } else if (useCustomProtocol) {
    popout.loadURL(`app://localhost/${hash}`)
  } else {
    popout.loadFile(join(__dirname, '../dist/index.html'), { hash: hash.slice(1) })
  }

  // Send auth token via IPC after window loads (avoids exposing it in URL)
  popout.webContents.once('did-finish-load', () => {
    popout.webContents.send('popout:authToken', params.authToken)
  })
})

// Open a tool call popout window
ipcMain.handle('toolcall:openPopout', async (_event, params: {
  toolCallId: string
  name: string
}) => {
  const hash = `#toolcall?id=${encodeURIComponent(params.toolCallId)}`

  const popout = new BrowserWindow({
    width: 700,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    title: `Tool: ${params.name}`,
    icon: join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    },
    backgroundColor: '#0d1117'
  })

  popout.setMenuBarVisibility(false)

  popout.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    popout.loadURL(`${process.env.VITE_DEV_SERVER_URL}${hash}`)
  } else if (useCustomProtocol) {
    popout.loadURL(`app://localhost/${hash}`)
  } else {
    popout.loadFile(join(__dirname, '../dist/index.html'), { hash: hash.slice(1) })
  }
})

// Proxy fetch for CORS-restricted URLs (e.g. ClawHub API, Convex)
ipcMain.handle('net:fetchUrl', async (_event, url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  // Only allow https URLs
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed')
  }

  const { net } = await import('electron')
  return new Promise<string>((resolve, reject) => {
    const request = net.request({
      url,
      method: options?.method || 'GET'
    })
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        request.setHeader(key, value)
      }
    }
    let body = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        body += chunk.toString()
      })
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(body)
        } else {
          reject(new Error(`HTTP ${response.statusCode}`))
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    if (options?.body) {
      request.write(options.body)
    }
    request.end()
  })
})

// Extract ZIP buffer to a target directory using pure Node.js (no external commands)
async function extractZipToDir(zipBuffer: Buffer, targetDir: string): Promise<string[]> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const zlib = await import('zlib')
  const extractedFiles: string[] = []

  // Find End of Central Directory record (signature 0x06054b50)
  let eocdOffset = -1
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65557); i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP file: no end-of-central-directory record')

  const cdEntries = zipBuffer.readUInt16LE(eocdOffset + 10)
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16)

  // Collect file entries from central directory
  const entries: Array<{ fileName: string; compressionMethod: number; compressedSize: number; localHeaderOffset: number }> = []
  let offset = cdOffset
  for (let i = 0; i < cdEntries; i++) {
    if (offset + 46 > zipBuffer.length) break
    if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) break

    const compressionMethod = zipBuffer.readUInt16LE(offset + 10)
    const compressedSize = zipBuffer.readUInt32LE(offset + 20)
    const fileNameLength = zipBuffer.readUInt16LE(offset + 28)
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 30)
    const commentLength = zipBuffer.readUInt16LE(offset + 32)
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42)
    const fileName = zipBuffer.toString('utf8', offset + 46, offset + 46 + fileNameLength)
    offset += 46 + fileNameLength + extraFieldLength + commentLength

    if (fileName.includes('..') || path.isAbsolute(fileName)) continue
    entries.push({ fileName, compressionMethod, compressedSize, localHeaderOffset })
  }

  // Strip common root directory prefix if all entries share one
  const firstSlash = entries.length > 0 ? entries[0].fileName.indexOf('/') : -1
  let stripPrefix = ''
  if (firstSlash > 0) {
    const candidate = entries[0].fileName.substring(0, firstSlash + 1)
    if (entries.every(e => e.fileName.startsWith(candidate))) {
      stripPrefix = candidate
    }
  }

  // Extract files
  for (const entry of entries) {
    const relativeName = stripPrefix ? entry.fileName.substring(stripPrefix.length) : entry.fileName
    if (!relativeName || relativeName.endsWith('/')) continue

    const localFileNameLen = zipBuffer.readUInt16LE(entry.localHeaderOffset + 26)
    const localExtraLen = zipBuffer.readUInt16LE(entry.localHeaderOffset + 28)
    const dataOffset = entry.localHeaderOffset + 30 + localFileNameLen + localExtraLen

    let fileData: Buffer
    if (entry.compressionMethod === 0) {
      fileData = zipBuffer.subarray(dataOffset, dataOffset + entry.compressedSize)
    } else if (entry.compressionMethod === 8) {
      const compressed = zipBuffer.subarray(dataOffset, dataOffset + entry.compressedSize)
      fileData = zlib.inflateRawSync(compressed)
    } else {
      createLogger('clawhub').warn(`Skipping ${relativeName}: unsupported compression method ${entry.compressionMethod}`)
      continue
    }

    const filePath = path.join(targetDir, relativeName)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, fileData)
    extractedFiles.push(relativeName)
  }

  return extractedFiles
}

// Download a ClawHub skill ZIP and extract to a target directory
ipcMain.handle('clawhub:install', async (_event, slug: string, targetDir: string) => {
  // Validate slug
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid skill slug: ${slug}`)
  }

  const fs = await import('fs/promises')

  // Download ZIP from ClawHub API
  const { net } = await import('electron')
  const downloadUrl = `https://clawhub.ai/api/v1/download?slug=${encodeURIComponent(slug)}`
  const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
    const request = net.request({ url: downloadUrl, method: 'GET' })
    const chunks: Buffer[] = []
    request.on('response', (response) => {
      if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }
      response.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })

  // Remove existing skill dir if present, then extract
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(targetDir, { recursive: true })
  const extractedFiles = await extractZipToDir(zipBuffer, targetDir)

  return { ok: true, files: extractedFiles }
})

// --- Clipboard access ---

ipcMain.handle('clipboard:read', async () => {
  return clipboard.readText()
})

ipcMain.handle('clipboard:write', async (_event, text: string) => {
  if (typeof text !== 'string') throw new Error('Invalid text')
  clipboard.writeText(text)
})

// --- Device status ---

ipcMain.handle('device:status', async () => {
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    memory: {
      total: os.totalmem(),
      free: os.freemem()
    },
    uptime: os.uptime()
  }
})

// --- Ed25519 crypto (Node.js, since Chromium Web Crypto lacks Ed25519) ---

ipcMain.handle('crypto:generateEd25519', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')

  // Export raw 32-byte public key
  const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' })
  // SPKI wrapping for Ed25519 adds a 12-byte header; raw key is the last 32 bytes
  const rawBytes = publicKeyRaw.subarray(publicKeyRaw.length - 32)
  const publicKeyBase64url = rawBytes.toString('base64url')

  // Device ID = SHA-256(raw public key) as hex
  const id = crypto.createHash('sha256').update(rawBytes).digest('hex')

  // Export private key as JWK for storage
  const privateKeyJwk = privateKey.export({ format: 'jwk' })

  return { id, publicKeyBase64url, privateKeyJwk }
})

ipcMain.handle('crypto:signEd25519', async (_event, privateKeyJwk: JsonWebKey, payload: string) => {
  const privateKey = crypto.createPrivateKey({ key: privateKeyJwk as crypto.JsonWebKey, format: 'jwk' })
  const signature = crypto.sign(null, Buffer.from(payload), privateKey)
  return signature.toString('base64url')
})

// Speech recognition, wake word, and Voice Assistant are handled by the speech module.
// Handlers are registered in setupSpeechHandlers() called after window creation.

// Trust a hostname for certificate errors (persisted across app restarts)
ipcMain.handle('cert:trustHost', async (_event, hostname: string) => {
  // Validate hostname format
  if (!hostname || typeof hostname !== 'string' || hostname.length > 253) {
    throw new Error('Invalid hostname')
  }
  // Basic hostname validation (alphanumeric, dots, hyphens)
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/
  if (!hostnameRegex.test(hostname)) {
    throw new Error('Invalid hostname format')
  }
  trustedHosts.add(hostname)
  saveTrustedHosts()
  return { trusted: true, hostname }
})
