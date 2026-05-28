import type { QueryDataResponse, QueryRequest, ReferenceItem, StreamEvent } from '../types/chat'

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '')

const formatHttpErrorMessage = (body: string, status: number) => {
  const trimmed = body.trim()
  if (!trimmed) {
    return `HTTP ${status}`
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      detail?: unknown
      message?: unknown
      error?: unknown
    }
    const { detail } = parsed

    if (Array.isArray(detail)) {
      const queryLengthError = detail.some((item) => {
        if (!item || typeof item !== 'object') {
          return false
        }
        const record = item as { loc?: unknown; type?: unknown }
        return (
          Array.isArray(record.loc) &&
          record.loc.includes('query') &&
          record.type === 'string_too_short'
        )
      })

      if (queryLengthError) {
        return '请输入有效问题后再发送'
      }

      const messages = detail
        .map((item) =>
          item && typeof item === 'object' && 'msg' in item
            ? String((item as { msg?: unknown }).msg ?? '')
            : ''
        )
        .filter(Boolean)
      if (messages.length > 0) {
        return messages.join('；')
      }
    }

    if (typeof detail === 'string' && detail) {
      return detail
    }
    if (typeof parsed.message === 'string' && parsed.message) {
      return parsed.message
    }
    if (typeof parsed.error === 'string' && parsed.error) {
      return parsed.error
    }
  } catch {
    // Fall through and show the original response body.
  }

  return trimmed
}

export const streamQuery = async (
  baseUrl: string,
  request: QueryRequest,
  auth: { apiKey?: string; bearerToken?: string },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
) => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    Accept: 'application/x-ndjson'
  }

  if (auth.apiKey) {
    headers['X-API-Key'] = auth.apiKey
  }

  if (auth.bearerToken) {
    headers.Authorization = `Bearer ${auth.bearerToken}`
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/query/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(formatHttpErrorMessage(body, response.status))
  }

  if (!response.body) {
    throw new Error('Stream body is empty')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const emitParsedEvent = (parsed: {
    references?: ReferenceItem[]
    response?: string
    response_final?: string
    error?: string
  }) => {
    if (typeof parsed.response_final === 'string') {
      onEvent({
        type: 'response_final',
        content: parsed.response_final,
        references: Array.isArray(parsed.references) ? parsed.references : undefined
      })
      return
    }

    if (Array.isArray(parsed.references)) {
      onEvent({
        type: 'references',
        references: parsed.references
      })
    }

    if (typeof parsed.response === 'string') {
      onEvent({ type: 'response', chunk: parsed.response })
    }

    if (typeof parsed.error === 'string') {
      onEvent({ type: 'error', error: parsed.error })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      emitParsedEvent(
        JSON.parse(trimmed) as {
          references?: ReferenceItem[]
          response?: string
          response_final?: string
          error?: string
        }
      )
    }
  }

  const trailing = buffer.trim()
  if (!trailing) {
    return
  }

  emitParsedEvent(
    JSON.parse(trailing) as {
      references?: ReferenceItem[]
      response?: string
      response_final?: string
      error?: string
    }
  )
}

export const fetchQueryData = async (
  baseUrl: string,
  request: QueryRequest,
  auth: { apiKey?: string; bearerToken?: string }
) => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json'
  }

  if (auth.apiKey) {
    headers['X-API-Key'] = auth.apiKey
  }

  if (auth.bearerToken) {
    headers.Authorization = `Bearer ${auth.bearerToken}`
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/query/data`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(formatHttpErrorMessage(body, response.status))
  }

  const data = (await response.json()) as QueryDataResponse
  if (data.status !== 'success') {
    throw new Error(data.message || '引用原文加载失败')
  }

  return data
}
