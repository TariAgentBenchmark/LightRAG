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

export const synthesizeSpeech = async (
  baseUrl: string,
  text: string,
  auth: { apiKey?: string; bearerToken?: string }
) => {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/speech/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(auth)
    },
    body: JSON.stringify({ text })
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
