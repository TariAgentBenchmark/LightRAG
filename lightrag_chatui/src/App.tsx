import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { streamQuery } from './api/lightrag'
import { loadConfig, loadSessions, saveConfig, saveSessions } from './lib/storage'
import { remarkCitations } from './lib/remarkCitations'
import type {
  AppConfig,
  ChatMessage,
  ChatSession,
  QueryMode,
  ReferenceItem
} from './types/chat'

const makeId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const MODE_OPTIONS: Array<{ value: QueryMode; label: string }> = [
  { value: 'mix', label: '混合检索' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'local', label: 'Local' },
  { value: 'global', label: 'Global' },
  { value: 'naive', label: 'Naive' },
  { value: 'bypass', label: 'Bypass' }
]

const STARTER_PROMPTS = [
  '做梦好不好？',
  '修炼的重点是是什么？',
  '什么是性命双修？',
  '玄德是什么？',
  '为什么自性为师是很重要的？',
  '什么是清净？',
  '元神是什么？',
  '什么是“反者道之动”？'
]

const summarizePath = (filePath: string) => {
  const pieces = filePath.split('/').filter(Boolean)
  const filename = pieces.at(-1) ?? filePath
  return filename.replace(/\.[^.]+$/, '')
}

const summarizeQuestion = (text: string) => {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > 28 ? `${singleLine.slice(0, 28)}...` : singleLine
}

const stripKnownFileExtensions = (text: string) =>
  text.replace(/\s*\.[A-Za-z0-9]{1,10}\b/g, '')

const buildConversationHistory = (messages: ChatMessage[], historyTurns: number) => {
  const eligible = messages
    .filter((message) => !message.isStreaming && !message.error)
    .map((message) => ({
      role: message.role,
      content: message.content
    }))

  if (historyTurns <= 0) {
    return []
  }

  return eligible.slice(-historyTurns * 2)
}

const mergeWrappedLine = (left: string, right: string) => {
  if (!left) {
    return right
  }

  if (!right) {
    return left
  }

  const lastChar = left.slice(-1)
  const firstChar = right.slice(0, 1)
  const needsSpace =
    /[A-Za-z0-9,.:;)\]]/.test(lastChar) && /[A-Za-z0-9([\"]/.test(firstChar)

  return needsSpace ? `${left} ${right}` : `${left}${right}`
}

const normalizeSnippet = (snippet: string) => {
  const normalized = snippet
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim()

  if (!normalized) {
    return []
  }

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .reduce((acc, line) => mergeWrappedLine(acc, line), '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    )
    .filter(Boolean)
}

const snippetParagraphs = (snippet?: string) => {
  const paragraphs = normalizeSnippet(snippet ?? '')
  return paragraphs.length > 0 ? paragraphs : ['当前引用未包含 chunk 内容。']
}

type CitationRefProps = {
  ids: string[]
  references: ReferenceItem[]
  onHoverStart: (id: string, anchorRect: DOMRect) => void
  onHoverEnd: () => void
  onSelect: (id: string) => void
}

const CitationRef = ({
  ids,
  references,
  onHoverStart,
  onHoverEnd,
  onSelect
}: CitationRefProps) => {
  const cited = ids
    .map((id) => references.find((reference) => reference.reference_id === id))
    .filter((reference): reference is ReferenceItem => Boolean(reference))

  if (cited.length === 0) {
    return <sup className="citation-missing">[{ids.join(', ')}]</sup>
  }

  return (
    <span className="citation">
      <button
        type="button"
        className="citation-trigger"
        onMouseEnter={(event) =>
          onHoverStart(cited[0].reference_id, event.currentTarget.getBoundingClientRect())
        }
        onMouseLeave={onHoverEnd}
        onFocus={(event) =>
          onHoverStart(cited[0].reference_id, event.currentTarget.getBoundingClientRect())
        }
        onBlur={onHoverEnd}
        onClick={() => onSelect(cited[0].reference_id)}
      >
        {ids.map((id) => (
          <span key={id} className="citation-token">
            {id}
          </span>
        ))}
      </button>
    </span>
  )
}

type MessageCardProps = {
  message: ChatMessage
  onHoverReferenceStart: (referenceId: string, messageId: string, anchorRect: DOMRect) => void
  onHoverReferenceEnd: () => void
  onSelectReference: (referenceId: string, messageId: string) => void
}

const MessageCard = ({
  message,
  onHoverReferenceStart,
  onHoverReferenceEnd,
  onSelectReference
}: MessageCardProps) => {
  const displayContent =
    message.role === 'assistant' ? stripKnownFileExtensions(message.content) : message.content

  const markdownComponents = useMemo(
    () => ({
      'citation-ref': (props: Record<string, unknown>) => {
        const rawIds = typeof props['data-ids'] === 'string' ? props['data-ids'] : ''
        const ids = rawIds
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)

        return (
          <CitationRef
            ids={ids}
            references={message.references ?? []}
            onHoverStart={(referenceId, anchorRect) =>
              onHoverReferenceStart(referenceId, message.id, anchorRect)
            }
            onHoverEnd={onHoverReferenceEnd}
            onSelect={(referenceId) => onSelectReference(referenceId, message.id)}
          />
        )
      },
      p: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
      ul: ({ children }: { children?: ReactNode }) => (
        <ul className="message-list">{children}</ul>
      ),
      ol: ({ children }: { children?: ReactNode }) => (
        <ol className="message-list ordered">{children}</ol>
      )
    }),
    [message.id, message.references, onHoverReferenceEnd, onHoverReferenceStart, onSelectReference]
  )

  return (
    <article className={`message ${message.role === 'user' ? 'user' : 'assistant'}`}>
      <div className="message-meta">
        <span>{message.role === 'user' ? '问' : '答'}</span>
        <span>
          {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
          })}
        </span>
      </div>
      <div className="message-body">
        {message.role === 'assistant' ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkCitations]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >
            {displayContent || (message.isStreaming ? '正在整理典籍脉络…' : '')}
          </ReactMarkdown>
        ) : (
          <p>{message.content}</p>
        )}
        {message.isStreaming && (
          <div className="stream-indicator" aria-live="polite">
            <span />
            <span />
            <span />
          </div>
        )}
        {message.error && <p className="message-error">{message.error}</p>}
      </div>
    </article>
  )
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig())
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions())
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    const initialSessions = loadSessions()
    return initialSessions[0]?.id ?? null
  })
  const [question, setQuestion] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [selectedCitation, setSelectedCitation] = useState<{
    messageId: string
    referenceId: string
  } | null>(null)
  const [isReferencePanelOpen, setIsReferencePanelOpen] = useState(false)
  const [hoverPreview, setHoverPreview] = useState<{
    messageId: string
    referenceId: string
    anchorRect: DOMRect
  } | null>(null)
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const hoverShowTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const hoverHideTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)

  useEffect(() => {
    saveConfig(config)
  }, [config])

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  useEffect(() => {
    if (currentSessionId && !sessions.some((session) => session.id === currentSessionId)) {
      setCurrentSessionId(sessions[0]?.id ?? null)
    }
  }, [currentSessionId, sessions])

  const currentSession =
    sessions.find((session) => session.id === currentSessionId) ?? null
  const messages = currentSession?.messages ?? []

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const selectedMessage =
    messages.find((message) => message.id === selectedCitation?.messageId) ?? null
  const selectedReference =
    selectedMessage?.references?.find(
      (reference) => reference.reference_id === selectedCitation?.referenceId
    ) ?? null
  const hoverMessage =
    messages.find((message) => message.id === hoverPreview?.messageId) ?? null
  const hoverReference =
    hoverMessage?.references?.find(
      (reference) => reference.reference_id === hoverPreview?.referenceId
    ) ?? null

  useEffect(() => {
    setSelectedCitation(null)
    setIsReferencePanelOpen(false)
  }, [currentSessionId])

  useEffect(() => {
    return () => {
      if (hoverShowTimerRef.current !== null) {
        window.clearTimeout(hoverShowTimerRef.current)
      }
      if (hoverHideTimerRef.current !== null) {
        window.clearTimeout(hoverHideTimerRef.current)
      }
    }
  }, [])

  const updateConfig = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfig((current) => ({
      ...current,
      [key]: value
    }))
  }

  const upsertSession = (
    sessionId: string,
    updater: (session: ChatSession) => ChatSession
  ) => {
    setSessions((current) => {
      const next = current.map((session) =>
        session.id === sessionId ? updater(session) : session
      )
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })
  }

  const resetConversation = () => {
    abortRef.current?.abort()
    setCurrentSessionId(null)
    setQuestion('')
    setIsSubmitting(false)
    setSelectedCitation(null)
    setIsReferencePanelOpen(false)
    setHoverPreview(null)
  }

  const submitQuestion = async (seedQuestion?: string) => {
    const content = (seedQuestion ?? question).trim()
    if (!content || isSubmitting) {
      return
    }

    const now = Date.now()
    const sessionId = currentSessionId ?? makeId()
    const baseMessages = currentSession?.messages ?? []
    const userMessage: ChatMessage = {
      id: makeId(),
      role: 'user',
      content,
      createdAt: now
    }
    const assistantMessage: ChatMessage = {
      id: makeId(),
      role: 'assistant',
      content: '',
      createdAt: now + 1,
      references: [],
      isStreaming: true
    }

    const nextSession: ChatSession = currentSession ?? {
      id: sessionId,
      title: summarizeQuestion(content),
      updatedAt: now,
      messages: []
    }

    const seededSession: ChatSession = {
      ...nextSession,
      title: nextSession.messages.length > 0 ? nextSession.title : summarizeQuestion(content),
      updatedAt: now,
      messages: [...baseMessages, userMessage, assistantMessage]
    }

    setSessions((current) => {
      const exists = current.some((session) => session.id === sessionId)
      const next = exists
        ? current.map((session) => (session.id === sessionId ? seededSession : session))
        : [seededSession, ...current]
      next.sort((a, b) => b.updatedAt - a.updatedAt)
      return next
    })

    setCurrentSessionId(sessionId)
    setQuestion('')
    setIsSubmitting(true)
    setSelectedCitation(null)
    setIsReferencePanelOpen(false)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamQuery(
        config.baseUrl,
        {
          query: content,
          mode: config.mode,
          stream: true,
          top_k: config.topK,
          include_references: true,
          include_chunk_content: true,
          conversation_history: buildConversationHistory(baseMessages, config.historyTurns)
        },
        {
          apiKey: config.apiKey,
          bearerToken: config.bearerToken
        },
        controller.signal,
        (event) => {
          upsertSession(sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.map((message) => {
              if (message.id !== assistantMessage.id) {
                return message
              }

              if (event.type === 'references') {
                return {
                  ...message,
                  references: event.references
                }
              }

              if (event.type === 'response') {
                return {
                  ...message,
                  content: message.content + stripKnownFileExtensions(event.chunk)
                }
              }

              if (event.type === 'error') {
                return {
                  ...message,
                  error: event.error,
                  isStreaming: false
                }
              }

              return message
            })
          }))
        }
      )
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? '已停止生成。'
          : error instanceof Error
            ? error.message
            : '请求失败'

      upsertSession(sessionId, (session) => ({
        ...session,
        updatedAt: Date.now(),
        messages: session.messages.map((item) =>
          item.id === assistantMessage.id
            ? {
                ...item,
                error: message
              }
            : item
        )
      }))
    } finally {
      upsertSession(sessionId, (session) => ({
        ...session,
        updatedAt: Date.now(),
        messages: session.messages.map((item) =>
          item.id === assistantMessage.id
            ? {
                ...item,
                isStreaming: false
              }
            : item
        )
      }))
      setIsSubmitting(false)
    }
  }

  const handleSelectReference = (referenceId: string, messageId: string) => {
    setSelectedCitation({ referenceId, messageId })
    setIsReferencePanelOpen(true)
  }

  const clearHoverHideTimer = () => {
    if (hoverHideTimerRef.current !== null) {
      window.clearTimeout(hoverHideTimerRef.current)
      hoverHideTimerRef.current = null
    }
  }

  const clearHoverShowTimer = () => {
    if (hoverShowTimerRef.current !== null) {
      window.clearTimeout(hoverShowTimerRef.current)
      hoverShowTimerRef.current = null
    }
  }

  const handleHoverReferenceStart = (
    referenceId: string,
    messageId: string,
    anchorRect: DOMRect
  ) => {
    clearHoverShowTimer()
    clearHoverHideTimer()
    hoverShowTimerRef.current = window.setTimeout(() => {
      setHoverPreview({ referenceId, messageId, anchorRect })
      hoverShowTimerRef.current = null
    }, 140)
  }

  const handleHoverReferenceEnd = () => {
    clearHoverShowTimer()
    clearHoverHideTimer()
    hoverHideTimerRef.current = window.setTimeout(() => {
      setHoverPreview(null)
      hoverHideTimerRef.current = null
    }, 120)
  }

  const hasMessages = messages.length > 0

  return (
    <div className={`app-shell ${isReferencePanelOpen && selectedReference ? 'with-reference-panel' : 'without-reference-panel'}`}>
      <div className="mist mist-a" />
      <div className="mist mist-b" />

      <aside className="left-rail">
        <div className="brand-block">
          <div className="brand-seal">道</div>
          <div>
            <h1>道教问答</h1>
          </div>
        </div>

        <button className="primary-action" onClick={resetConversation}>
          新建一卷
        </button>

        <section className="rail-section history-section">
          <div className="section-row">
            <p className="section-label">历史记录</p>
            <button
              className="text-button"
              onClick={() => {
                setSessions([])
                setCurrentSessionId(null)
                setSelectedCitation(null)
              }}
            >
              清空
            </button>
          </div>
          <div className="history-list">
            {sessions.length === 0 ? (
              <div className="history-empty">还没有历史会话。</div>
            ) : (
              sessions.map((session) => {
                const preview = session.messages.find((message) => message.role === 'assistant')
                return (
                  <button
                    key={session.id}
                    className={`history-item ${
                      session.id === currentSessionId ? 'active' : ''
                    }`}
                    onClick={() => {
                      setCurrentSessionId(session.id)
                      setSelectedCitation(null)
                    }}
                  >
                    <span className="history-title">{session.title}</span>
                    <span className="history-preview">
                      {preview?.content
                        ? summarizeQuestion(preview.content)
                        : '等待回答'}
                    </span>
                    <span className="history-time">
                      {new Date(session.updatedAt).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </section>

        <section className="rail-section">
          <div className="section-row">
            <p className="section-label">接口设定</p>
            <button className="text-button" onClick={() => setShowSettings((value) => !value)}>
              {showSettings ? '收起' : '展开'}
            </button>
          </div>
          {showSettings && (
            <div className="settings-card">
              <label>
                API Base URL
                <input
                  value={config.baseUrl}
                  onChange={(event) => updateConfig('baseUrl', event.target.value)}
                  placeholder="http://localhost:9621"
                />
              </label>
              <label>
                X-API-Key
                <input
                  value={config.apiKey}
                  onChange={(event) => updateConfig('apiKey', event.target.value)}
                  placeholder="可留空"
                />
              </label>
              <label>
                Bearer Token
                <input
                  value={config.bearerToken}
                  onChange={(event) => updateConfig('bearerToken', event.target.value)}
                  placeholder="可留空"
                />
              </label>
            </div>
          )}
        </section>
      </aside>

      <main className="chat-stage">
        <header className="topbar">
          <div>
            <h2>经卷问答册</h2>
          </div>
          <div className="topbar-settings">
            <button
              type="button"
              className="advanced-toggle"
              onClick={() => setShowAdvancedOptions((value) => !value)}
            >
              <span>高级选项</span>
              <span>{showAdvancedOptions ? '收起' : '展开'}</span>
            </button>

            {showAdvancedOptions && (
              <div className="topbar-controls advanced-controls">
                <label>
                  检索模式
                  <select
                    value={config.mode}
                    onChange={(event) => updateConfig('mode', event.target.value as QueryMode)}
                  >
                    {MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Top K
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={config.topK}
                    onChange={(event) => updateConfig('topK', Number(event.target.value) || 1)}
                  />
                </label>
                <label>
                  历史轮数
                  <input
                    type="number"
                    min={0}
                    max={12}
                    value={config.historyTurns}
                    onChange={(event) =>
                      updateConfig('historyTurns', Math.max(0, Number(event.target.value) || 0))
                    }
                  />
                </label>
              </div>
            )}
          </div>
        </header>

        <section className="chat-thread">
          {!hasMessages ? (
            <div className="empty-state">
              <p className="empty-kicker">起问引子</p>
              <h3>从一条问题开始，让典籍自己发声</h3>
              <div className="empty-prompt-grid">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    className="empty-prompt-card"
                    onClick={() => void submitQuestion(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                onHoverReferenceStart={handleHoverReferenceStart}
                onHoverReferenceEnd={handleHoverReferenceEnd}
                onSelectReference={handleSelectReference}
              />
            ))
          )}
          <div ref={chatEndRef} />
        </section>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void submitQuestion()
          }}
        >
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="可问经义、术语、修持次第、梦境材料对读等。"
            rows={3}
          />
          <div className="composer-footer">
            <div className="composer-actions">
              {isSubmitting && (
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => abortRef.current?.abort()}
                >
                  停止
                </button>
              )}
              <button type="submit" className="primary-action" disabled={isSubmitting}>
                {isSubmitting ? '生成中…' : '发问'}
              </button>
            </div>
          </div>
        </form>
      </main>

      {isReferencePanelOpen && selectedReference && (
        <aside className="reference-panel">
          <div className="reference-header">
            <div>
              <p className="section-label">参考经卷</p>
              <h3>引文详情</h3>
            </div>
            <button
              type="button"
              className="reference-close"
              onClick={() => setIsReferencePanelOpen(false)}
              aria-label="关闭参考经卷"
            >
              关闭
            </button>
          </div>

          <article className="reference-card">
            <p className="reference-badge">[{selectedReference.reference_id}]</p>
            <h4>{summarizePath(selectedReference.file_path)}</h4>
            <p className="reference-path">{selectedReference.file_path}</p>
            <div className="reference-snippets">
              {(selectedReference.content ?? ['当前引用未包含 chunk 内容。']).map((snippet, index) => (
                <blockquote key={`${selectedReference.reference_id}-${index}`}>
                  {snippetParagraphs(snippet).map((paragraph, paragraphIndex) => (
                    <p key={`${selectedReference.reference_id}-${index}-${paragraphIndex}`}>
                      {paragraph}
                    </p>
                  ))}
                </blockquote>
              ))}
            </div>
          </article>
        </aside>
      )}

      {hoverPreview && hoverReference && (
        <div
          className="floating-reference-preview"
          style={{
            top: Math.min(hoverPreview.anchorRect.bottom + 12, window.innerHeight - 340),
            left: Math.min(
              Math.max(hoverPreview.anchorRect.left - 16, 16),
              window.innerWidth - 380
            )
          }}
          onMouseEnter={clearHoverHideTimer}
          onMouseLeave={handleHoverReferenceEnd}
        >
          <p className="reference-badge">[{hoverReference.reference_id}]</p>
          <h4>{summarizePath(hoverReference.file_path)}</h4>
          <p className="reference-path">{hoverReference.file_path}</p>
          <div className="floating-reference-content">
            {(hoverReference.content ?? ['当前引用未包含 chunk 内容。']).map((snippet, index) => (
              <blockquote key={`${hoverReference.reference_id}-hover-${index}`}>
                {snippetParagraphs(snippet).map((paragraph, paragraphIndex) => (
                  <p key={`${hoverReference.reference_id}-hover-${index}-${paragraphIndex}`}>
                    {paragraph}
                  </p>
                ))}
              </blockquote>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
