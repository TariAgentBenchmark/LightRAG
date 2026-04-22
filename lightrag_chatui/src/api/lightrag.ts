import type { QueryRequest, ReferenceItem, StreamEvent } from '../types/chat'

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '')

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
    throw new Error(body || `HTTP ${response.status}`)
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
