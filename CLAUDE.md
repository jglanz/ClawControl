# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Desktop (Electron)
npm run dev          # Start development server with hot reload
npm run build:win    # Build for Windows (from Windows)
npm run build:mac    # Build for macOS (from macOS)

# Mobile (Capacitor)
npm run mobile:dev     # Start mobile dev server (browser preview)
npm run mobile:build   # Build web assets for mobile
npm run mobile:sync    # Build and sync to native projects
npm run mobile:ios     # Build, sync, and open in Xcode
npm run mobile:android # Build, sync, and open in Android Studio

# Testing & Quality
npm run test         # Run tests in watch mode
npm run test:run     # Run tests once
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
```

## Architecture

ClawControl is a cross-platform client for OpenClaw AI assistant. It runs as an Electron desktop app and as a native mobile app (iOS/Android) via Capacitor.

### Desktop Process Structure (Electron)
- **Main Process** (`electron/main.ts`): Electron main process, handles window creation and IPC
- **Preload** (`electron/preload.ts`): Bridge between main and renderer, exposes `window.electronAPI`
- **Renderer** (`src/`): React application

### Mobile Architecture (Capacitor)
- **Platform Layer** (`src/lib/platform.ts`): Abstraction over Electron/Capacitor/web APIs (token storage, external links, status bar, keyboard)
- **Capacitor Config** (`capacitor.config.ts`): Native app configuration
- **Vite Config** (`vite.config.mobile.ts`): Web build without Electron plugins
- **Native Projects**: `ios/` and `android/` directories (generated, gitignored)

### Core Data Flow
1. **OpenClawClient** (`src/lib/openclaw/client.ts`): Custom WebSocket client implementing a frame-based JSON-RPC protocol (v3). Handles connection, authentication, and real-time message streaming with per-session stream isolation.
2. **Zustand Store** (`src/store/index.ts`): Central state management with persistence. All app state flows through here. Per-session streaming maps (`streamingSessions`, `sessionHadChunks`, `sessionToolCalls`) enable concurrent agent conversations.
3. **Components**: React components consume store state via `useStore()` hook.

### Client Module Structure (`src/lib/openclaw/`)
- `client.ts` — Core WebSocket connection, event routing, per-session stream state
- `types.ts` — Protocol frame types, domain interfaces (`Message`, `Session`, `Agent`, etc.)
- `chat.ts` — `chat.send`, `chat.history`, `chat.abort` RPC methods
- `sessions.ts` — Session CRUD and `sessions.spawn`
- `agents.ts` — Agent listing, identity, file management, create/delete
- `config.ts` — Server config read (`config.get`) and write (`config.patch`)
- `skills.ts` — Skill listing, toggle, install
- `cron-jobs.ts` — Cron job listing, toggle, details
- `utils.ts` — ANSI stripping, content extraction, heartbeat detection
- `index.ts` — Public re-exports

### Protocol Details
The OpenClaw protocol uses typed frames:
- `req`: Outgoing requests with `method` and `params`
- `res`: Responses with `ok` boolean and `payload`/`error`
- `event`: Server-pushed events like `chat`, `agent`, `presence`, `connect.challenge`

Key RPC methods: `sessions.list`, `sessions.spawn`, `sessions.patch`, `sessions.delete`, `chat.send`, `chat.history`, `chat.abort`, `agents.list`, `agent.identity.get`, `agents.files.list`, `agents.files.get`, `agents.files.set`, `config.get`, `config.patch`, `skills.status`, `skills.update`, `skills.install`, `cron.list`, `cron.get`, `cron.update`, `talk.speak`, `talk.config`, `talk.mode`, `tts.status`, `tts.enable`, `tts.disable`, `voicewake.get`, `voicewake.set`

### Streaming Architecture
The client uses **per-session stream isolation** via `Map<string, SessionStreamState>`. Each session independently tracks its stream source (chat vs agent), accumulated text, mode (delta vs cumulative), and content block offsets. This allows multiple agents to stream simultaneously without cross-contaminating text buffers.

Key streaming concepts:
- **Stream source arbitration**: First event type (`chat` or `agent`) to arrive for a session claims it; the other is ignored for that session to prevent duplicate content.
- **Cumulative text merging**: The server sends `data.text` as cumulative per-content-block (resets after tool calls). The client detects rewinds and accumulates with `\n\n` separators.
- **Parent session tracking**: `parentSessionKeys: Set<string>` tracks sessions the user has sent messages to. Events from unknown sessions trigger subagent detection.
- **Session key resolution**: Events without `sessionKey` fall back to `defaultSessionKey` (the most recent send target).

Server event types:
- `chat { state: "delta" }` — Cumulative text chunk with `delta` or `message.content`
- `chat { state: "final" }` — Complete message with canonical `message` object
- `agent { stream: "assistant" }` — Text output with `data.text` (cumulative) or `data.delta`
- `agent { stream: "tool" }` — Tool call start/result with `data.name`, `data.phase`, `data.result`
- `agent { stream: "lifecycle" }` — Agent lifecycle; `data.state: "complete"` or `data.phase: "end"` signals stream end
- `presence` — Agent online/offline status changes

All server events include an optional `sessionKey` field identifying which session they belong to.

### Voice / Speech Architecture

ClawControl implements native voice features for all desktop platforms:

**Speech-to-Text (STT):**
- **Windows**: System.Speech via PowerShell
- **Linux/macOS**: whisper.cpp with CUDA GPU acceleration. Records audio via `parec`/`arecord`/`sox`, transcribes via `whisper-cli` with configurable model (default: `ggml-large-v3.bin`)
- **Mobile**: Capacitor `@capacitor-community/speech-recognition`

**Wake Word Detection:**
- Server-managed triggers via `voicewake.get`/`voicewake.set` RPC
- Linux/macOS: whisper.cpp `stream` binary runs continuously, pattern-matches transcriptions against triggers
- Mobile/Web: Browser `webkitSpeechRecognition` fallback

**Voice Assistant Mode:**
Continuous conversation loop activated by wake word command ("Hey Jarvis, start voice assistant"), global hotkey (`Super+/`), or UI button:
1. Listen (record audio with silence detection)
2. Transcribe (whisper-cli)
3. Send transcript via `chat.send`
4. Wait for response
5. Speak response via `talk.speak` RPC (server-side TTS: ElevenLabs/Edge/OpenAI)
6. Loop (interrupt-aware if `interruptOnSpeech` enabled)

Deactivated by voice ("stop assistant", "stop jarvis"), hotkey, or UI.

**TTS Playback:**
- Server-side synthesis via `talk.speak` RPC returns base64 audio
- Renderer decodes and plays via HTMLAudioElement
- Auto-play configurable per user preference

**Speech Module Structure (`electron/speech/`):**
- `detect.ts` — Find whisper binaries, models, recording tools, CUDA
- `recorder.ts` — Record microphone to WAV (parec/arecord/sox)
- `stt.ts` — Transcribe WAV via whisper-cli
- `wake.ts` — Continuous wake detection via whisper stream
- `assistant.ts` — Voice Assistant listen-transcribe-send loop
- `index.ts` — IPC handlers, global hotkey registration

**Environment Variables:**
- `WHISPER_CPP_BINARY` — Path to whisper-cli binary
- `WHISPER_CPP_STREAM` — Path to whisper stream binary
- `WHISPER_CPP_MODEL` — Path to GGML model file

### Component Layout
```
App
├── Sidebar          # Session list, collapsible
├── main-content
│   ├── TopBar       # Agent selector, theme toggle, settings
│   ├── ChatArea     # Message display with markdown support
│   ├── InputArea    # Message input with thinking mode toggle
│   ├── SkillDetailView  # Full skill details when selected
│   ├── CronJobDetailView
│   └── ServerSettingsView  # Full-page server config editor
├── RightPanel       # Skills/Crons tabs
└── Modals          # SettingsModal, CertErrorModal
```

### Server Settings View
The `ServerSettingsView` component (`src/components/ServerSettingsView.tsx`) provides a full-page editor for OpenClaw server configuration. It uses `config.get` to load the full config and `config.patch` to save changes.

Key design:
- **Three tabs**: Agent Defaults (model, thinking, limits), Tools & Memory (web tools, exec, memory backend), Channels (per-channel enable with policies)
- **Local state only**: Config is managed in component state, not Zustand, since it's a one-off read/write workflow
- **Dirty tracking**: Compares all editable paths between original and edited config to show/hide save bar
- **Minimal patch**: Only changed paths are included in the `config.patch` payload
- **Reconnect handling**: After save, waits for server restart/reconnect (same pattern as `createAgent`), then reloads fresh config
- **Hash-based conflict detection**: Uses `baseHash` from `config.get` to detect concurrent edits

Accessible via: Settings modal (gear icon) > "OpenClaw Server Settings" button (only shown when connected).

### State Persistence
The Zustand store persists to localStorage (`clawcontrol-storage`): theme, serverUrl, authMode, gatewayToken, sidebarCollapsed, thinkingEnabled.
