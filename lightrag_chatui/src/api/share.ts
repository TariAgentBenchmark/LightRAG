import type { ShareCreateResponse, ShareGetResponse, SharePayload } from '../types/chat'

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

export const createShare = async (
  baseUrl: string,
  payload: SharePayload,
  auth: { apiKey?: string; bearerToken?: string }
) => {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/shares`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(auth)
    },
    body: JSON.stringify({ payload })
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `HTTP ${response.status}`)
  }

  return response.json() as Promise<ShareCreateResponse>
}

export const fetchShare = async (baseUrl: string, shareId: string) => {
  const response = await fetch(
    `${normalizeBaseUrl(baseUrl)}/shares/${encodeURIComponent(shareId)}`
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `HTTP ${response.status}`)
  }

  return response.json() as Promise<ShareGetResponse>
}
