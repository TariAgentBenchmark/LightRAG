export type QueryMode = 'naive' | 'local' | 'global' | 'hybrid' | 'mix' | 'bypass'

export type ReferenceItem = {
  reference_id: string
  file_path: string
  content?: string[]
  entity_terms?: string[]
}

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  references?: ReferenceItem[]
  isStreaming?: boolean
  error?: string
}

export type ChatSession = {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
}

export type AppConfig = {
  baseUrl: string
  apiKey: string
  bearerToken: string
  mode: QueryMode
  topK: number
  historyTurns: number
}

export type StreamEvent =
  | { type: 'references'; references: ReferenceItem[] }
  | { type: 'response'; chunk: string }
  | { type: 'error'; error: string }

export type QueryRequest = {
  query: string
  mode: QueryMode
  stream: boolean
  top_k?: number
  include_references: boolean
  include_chunk_content: boolean
  conversation_history: Array<{ role: 'user' | 'assistant'; content: string }>
}
