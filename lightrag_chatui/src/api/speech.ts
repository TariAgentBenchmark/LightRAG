import type { SpeechStatusResponse, SpeechVoicesResponse } from '../types/chat'

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '')

const buildAuthHeaders = (auth: { apiKey?: string; bearerToken?: string }): HeadersInit => {
  const headers: HeadersInit = {}

  if (auth.apiKey) {
    headers['X-API-Key'] = auth.apiKey
  }

  if (auth.bearerToken) {
    headers.Authorization = `Bearer ${auth.bearerToken}`
  }

  return headers
}

const fetchJson = async <T>(
  baseUrl: string,
  path: string,
  auth: { apiKey?: string; bearerToken?: string }
) => {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    headers: buildAuthHeaders(auth)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `HTTP ${response.status}`)
  }

  return response.json() as Promise<T>
}

export const fetchSpeechStatus = (
  baseUrl: string,
  auth: { apiKey?: string; bearerToken?: string }
) => fetchJson<SpeechStatusResponse>(baseUrl, '/speech/status', auth)

export const fetchSpeechVoices = (
  baseUrl: string,
  auth: { apiKey?: string; bearerToken?: string }
) => fetchJson<SpeechVoicesResponse>(baseUrl, '/speech/voices', auth)

type SynthesizeSpeechOptions = {
  speakerId?: string
  speedRatio?: number
  volumeRatio?: number
  pitchRatio?: number
}

export const synthesizeSpeech = async (
  baseUrl: string,
  text: string,
  auth: { apiKey?: string; bearerToken?: string },
  options: SynthesizeSpeechOptions = {}
) => {
  const body = {
    text,
    ...(options.speakerId ? { speaker_id: options.speakerId } : {}),
    ...(options.speedRatio !== undefined ? { speed_ratio: options.speedRatio } : {}),
    ...(options.volumeRatio !== undefined ? { volume_ratio: options.volumeRatio } : {}),
    ...(options.pitchRatio !== undefined ? { pitch_ratio: options.pitchRatio } : {})
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/speech/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(auth)
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `HTTP ${response.status}`)
  }

  return response.blob()
}

export const createSpeechAsrSocket = (
  baseUrl: string,
  auth: { apiKey?: string; bearerToken?: string }
) => {
  const httpUrl = new URL(`${normalizeBaseUrl(baseUrl)}/speech/asr/stream`)
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  if (auth.apiKey) {
    httpUrl.searchParams.set('api_key', auth.apiKey)
  }

  if (auth.bearerToken) {
    httpUrl.searchParams.set('token', auth.bearerToken)
  }

  return new WebSocket(httpUrl.toString())
}
