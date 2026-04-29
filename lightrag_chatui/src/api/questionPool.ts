import type { QuestionPoolResponse } from '../types/chat'

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

export const fetchQuestionPool = async (
  baseUrl: string,
  auth: { apiKey?: string; bearerToken?: string },
  limit = 24
) => {
  const params = new URLSearchParams({ limit: String(limit) })
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/question-pool?${params}`, {
    headers: buildAuthHeaders(auth)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `HTTP ${response.status}`)
  }

  return response.json() as Promise<QuestionPoolResponse>
}

