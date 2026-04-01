import type { RpcCaller } from './types'

export async function getUsageStatus(call: RpcCaller): Promise<any> {
    return call('usage.status')
}
export async function getUsageCost(call: RpcCaller): Promise<any> {
    return call('usage.cost')
}
export async function getSessionsUsage(call: RpcCaller, params?: { days?: number; limit?: number }): Promise<any> {
    return call('sessions.usage', params ?? { limit: 200 })
}

export async function getTtsStatus(call: RpcCaller): Promise<any> {
    return call('tts.status')
}
export async function getTtsProviders(call: RpcCaller): Promise<any> {
    return call('tts.providers')
}
export async function setTtsEnable(call: RpcCaller, enable: boolean): Promise<any> {
    return call(enable ? 'tts.enable' : 'tts.disable')
}
export async function setTtsProvider(call: RpcCaller, provider: string): Promise<any> {
    return call('tts.setProvider', { provider })
}

export async function getVoicewake(call: RpcCaller): Promise<any> {
    return call('voicewake.get')
}
export async function setVoicewake(call: RpcCaller, params: any): Promise<any> {
    return call('voicewake.set', params)
}

// Talk mode
export interface TalkSpeakParams {
    text: string
    voiceId?: string
    modelId?: string
    outputFormat?: string
    speed?: number
    stability?: number
    similarity?: number
    style?: number
    speakerBoost?: boolean
    seed?: number
    normalize?: string
    language?: string
}

export interface TalkSpeakResult {
    audioBase64: string
    provider: string
    outputFormat?: string
    voiceCompatible?: boolean
    mimeType?: string
    fileExtension?: string
}

export interface TalkConfig {
    talk?: {
        provider?: string
        voiceId?: string
        modelId?: string
        outputFormat?: string
        interruptOnSpeech?: boolean
        silenceTimeoutMs?: number
    }
    session?: { mainKey?: string }
    ui?: { seamColor?: string }
}

export async function talkSpeak(call: RpcCaller, params: TalkSpeakParams): Promise<TalkSpeakResult> {
    return call('talk.speak', params)
}
export async function talkConfig(call: RpcCaller, includeSecrets = false): Promise<{ config: TalkConfig }> {
    return call('talk.config', { includeSecrets })
}
export async function talkMode(call: RpcCaller, enabled: boolean, phase?: string): Promise<any> {
    return call('talk.mode', { enabled, phase })
}
