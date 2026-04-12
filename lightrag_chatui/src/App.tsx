import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { streamQuery } from './api/lightrag'
import { createSpeechAsrSocket, synthesizeSpeech } from './api/speech'
import { getPCMRecorderSupportError, startPCMRecorder } from './lib/pcmRecorder'
import { loadConfig, loadSessions, saveConfig, saveSessions } from './lib/storage'
import { remarkCitations } from './lib/remarkCitations'
import type {
  AppConfig,
  ChatMessage,
  ChatSession,
  ReferenceItem
} from './types/chat'

const makeId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

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

const stripCitationMarkers = (text: string) =>
  text.replace(/\[(\^?\d+(?:\s*,\s*\d+)*)\]/g, '')

const toSpeakableText = (text: string) =>
  stripCitationMarkers(stripKnownFileExtensions(text))
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

const ANSWER_DISCLAIMER =
  '以上AI解答仅作参考。最终要以厚音老师的本人的回答为准。'

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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const normalizeEntityTerms = (terms?: string[]) =>
  Array.from(
    new Set(
      (terms ?? [])
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .sort((left, right) => right.length - left.length)
    )
  )

const highlightEntityTerms = (text: string, entityTerms?: string[]) => {
  const terms = normalizeEntityTerms(entityTerms)
  if (!text || terms.length === 0) {
    return text
  }

  const pattern = new RegExp(`(${terms.map((term) => escapeRegExp(term)).join('|')})`, 'giu')
  const matcher = new Set(terms.map((term) => term.toLocaleLowerCase('zh-CN')))

  return text.split(pattern).map((part, index) => {
    if (!part) {
      return null
    }

    if (matcher.has(part.toLocaleLowerCase('zh-CN'))) {
      return (
        <mark key={`${part}-${index}`} className="entity-highlight">
          {part}
        </mark>
      )
    }

    return <span key={`${part}-${index}`}>{part}</span>
  })
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
  isSpeaking: boolean
  isSpeechLoading: boolean
  onHoverReferenceStart: (referenceId: string, messageId: string, anchorRect: DOMRect) => void
  onHoverReferenceEnd: () => void
  onSelectReference: (referenceId: string, messageId: string) => void
  onToggleSpeak: (message: ChatMessage) => void
}

const MessageCard = ({
  message,
  isSpeaking,
  isSpeechLoading,
  onHoverReferenceStart,
  onHoverReferenceEnd,
  onSelectReference,
  onToggleSpeak
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

  const shouldShowDisclaimer =
    message.role === 'assistant' &&
    !message.isStreaming &&
    !message.error &&
    displayContent.trim().length > 0

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
        {message.role === 'assistant' && !message.isStreaming && !message.error && (
          <button
            type="button"
            className={`message-audio-button ${isSpeaking ? 'active' : ''}`}
            onClick={() => onToggleSpeak(message)}
            disabled={isSpeechLoading && !isSpeaking}
          >
            {isSpeechLoading && !isSpeaking ? '朗读准备中…' : isSpeaking ? '停止朗读' : '朗读'}
          </button>
        )}
      </div>
      <div className="message-body">
        {message.role === 'assistant' ? (
          <>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkCitations]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {displayContent || (message.isStreaming ? '请稍候...' : '')}
            </ReactMarkdown>
            {shouldShowDisclaimer && (
              <p className="answer-disclaimer">{ANSWER_DISCLAIMER}</p>
            )}
          </>
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
  const [isRecording, setIsRecording] = useState(false)
  const [speechError, setSpeechError] = useState('')
  const [speechLoadingMessageId, setSpeechLoadingMessageId] = useState<string | null>(null)
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [touchReference, setTouchReference] = useState<{
    messageId: string
    referenceId: string
  } | null>(null)
  const [hoverPreview, setHoverPreview] = useState<{
    messageId: string
    referenceId: string
    anchorRect: DOMRect
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const asrSocketRef = useRef<WebSocket | null>(null)
  const recorderStopRef = useRef<(() => Promise<void>) | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const hoverShowTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const hoverHideTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const voiceInputSupportError = getPCMRecorderSupportError()

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

  const hoverMessage =
    messages.find((message) => message.id === hoverPreview?.messageId) ?? null
  const hoverReference =
    hoverMessage?.references?.find(
      (reference) => reference.reference_id === hoverPreview?.referenceId
    ) ?? null

  const touchMessage = touchReference
    ? messages.find((message) => message.id === touchReference.messageId)
    : null
  const touchMessageReference = touchMessage?.references?.find(
    (reference) => reference.reference_id === touchReference?.referenceId
  ) ?? null

  const resizeTextarea = (value: string) => {
    if (!textareaRef.current) {
      return
    }

    textareaRef.current.value = value
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
  }

  const handleTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value
    setQuestion(nextValue)
    resizeTextarea(nextValue)
  }

  useEffect(() => {
    setHoverPreview(null)
    setTouchReference(null)
  }, [currentSessionId])

  useEffect(() => {
    return () => {
      if (hoverShowTimerRef.current !== null) {
        window.clearTimeout(hoverShowTimerRef.current)
      }
      if (hoverHideTimerRef.current !== null) {
        window.clearTimeout(hoverHideTimerRef.current)
      }

      asrSocketRef.current?.close()
      asrSocketRef.current = null

      void recorderStopRef.current?.()
      recorderStopRef.current = null

      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }

      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = null
      }
    }
  }, [])

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

  const closeMobileDrawer = () => setMobileDrawerOpen(false)

  const resetConversation = () => {
    abortRef.current?.abort()
    asrSocketRef.current?.close()
    asrSocketRef.current = null
    void recorderStopRef.current?.()
    recorderStopRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
    setPlayingMessageId(null)
    setSpeechLoadingMessageId(null)
    setIsRecording(false)
    setSpeechError('')
    setCurrentSessionId(null)
    setQuestion('')
    setIsSubmitting(false)
    setHoverPreview(null)
    setMobileDrawerOpen(false)
  }

  const stopSpeaking = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }

    setPlayingMessageId(null)
    setSpeechLoadingMessageId(null)
  }

  const handleToggleSpeak = async (message: ChatMessage) => {
    if (playingMessageId === message.id) {
      stopSpeaking()
      return
    }

    stopSpeaking()
    setSpeechError('')
    setSpeechLoadingMessageId(message.id)

    try {
      const speakableText = toSpeakableText(message.content)
      if (!speakableText) {
        throw new Error('当前回答没有可朗读的内容。')
      }

      const blob = await synthesizeSpeech(config.baseUrl, speakableText, {
        apiKey: config.apiKey,
        bearerToken: config.bearerToken
      })

      const audioUrl = URL.createObjectURL(blob)
      const audio = new Audio(audioUrl)
      audioRef.current = audio
      audioUrlRef.current = audioUrl
      setPlayingMessageId(message.id)

      audio.onended = () => {
        stopSpeaking()
      }
      audio.onerror = () => {
        setSpeechError('语音播放失败。')
        stopSpeaking()
      }

      await audio.play()
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : '语音合成失败。')
      stopSpeaking()
    } finally {
      setSpeechLoadingMessageId((current) => (current === message.id ? null : current))
    }
  }

  const stopVoiceInput = async () => {
    const socket = asrSocketRef.current
    const stopRecorder = recorderStopRef.current

    recorderStopRef.current = null
    asrSocketRef.current = null

    if (stopRecorder) {
      await stopRecorder()
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'end' }))
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }

    setIsRecording(false)
  }

  const startVoiceInput = async () => {
    if (isRecording) {
      await stopVoiceInput()
      return
    }

    stopSpeaking()
    setSpeechError('')

    if (voiceInputSupportError) {
      setSpeechError(voiceInputSupportError)
      return
    }

    let socket: WebSocket | null = null

    try {
      socket = createSpeechAsrSocket(config.baseUrl, {
        apiKey: config.apiKey,
        bearerToken: config.bearerToken
      })
      socket.binaryType = 'arraybuffer'

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () => reject(new Error('语音识别连接失败。'))
      })

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          return
        }

        const payload = JSON.parse(event.data) as {
          type: string
          text?: string
          is_final?: boolean
          message?: string
        }

        if (payload.type === 'transcript' && typeof payload.text === 'string') {
          setQuestion(payload.text)
          resizeTextarea(payload.text)
          return
        }

        if (payload.type === 'error') {
          setSpeechError(payload.message ?? '语音识别失败。')
          void stopVoiceInput()
        }
      }

      socket.onerror = () => {
        setSpeechError('语音识别连接失败。')
      }

      socket.onclose = () => {
        setIsRecording(false)
      }

      const recorder = await startPCMRecorder((chunk) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(chunk)
        }
      })

      recorderStopRef.current = recorder.stop
      asrSocketRef.current = socket
      setIsRecording(true)
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : '无法启动语音输入。')
      setIsRecording(false)
      socket?.close()
      asrSocketRef.current?.close()
      asrSocketRef.current = null
      recorderStopRef.current = null
    }
  }

  useEffect(() => {
    stopSpeaking()
  }, [currentSessionId])

  const submitQuestion = async (seedQuestion?: string) => {
    if (isRecording) {
      await stopVoiceInput()
    }

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
    setSpeechError('')
    setHoverPreview(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

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
    setTouchReference({ referenceId, messageId })
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
    <div className="app-shell">
      <div className="mist mist-a" />
      <div className="mist mist-b" />

      <button
        type="button"
        className={`mobile-drawer-overlay ${mobileDrawerOpen ? 'open' : ''}`}
        onClick={closeMobileDrawer}
        aria-label="关闭菜单"
      />

      <aside className={`left-rail ${mobileDrawerOpen ? 'mobile-open' : ''}`}>
        <div className="brand-block">
          <div className="brand-seal">道</div>
          <div>
            <h1>玄德问答</h1>
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
                setHoverPreview(null)
                closeMobileDrawer()
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
                      setHoverPreview(null)
                      closeMobileDrawer()
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

      </aside>

      <main className="chat-stage">
        <header className="topbar">
          <button
            type="button"
            className="mobile-menu-toggle"
            onClick={() => setMobileDrawerOpen(true)}
            aria-label="打开菜单"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="topbar-title">
            <h2>经卷问答册</h2>
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
                isSpeaking={playingMessageId === message.id}
                isSpeechLoading={speechLoadingMessageId === message.id}
                onHoverReferenceStart={handleHoverReferenceStart}
                onHoverReferenceEnd={handleHoverReferenceEnd}
                onSelectReference={handleSelectReference}
                onToggleSpeak={handleToggleSpeak}
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
            ref={textareaRef}
            value={question}
            onChange={handleTextareaChange}
            placeholder="写下你的问题"
            rows={1}
          />
          <div className="composer-footer">
            {speechError ? <p className="composer-status composer-error">{speechError}</p> : <span />}
            <div className="composer-actions">
              <button
                type="button"
                className={`secondary-action mic-action ${isRecording ? 'recording' : ''}`}
                onClick={() => void startVoiceInput()}
                disabled={isSubmitting || (!isRecording && Boolean(voiceInputSupportError))}
                title={voiceInputSupportError ?? undefined}
              >
                {isRecording ? '停止收音' : '话筒输入'}
              </button>
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
          {normalizeEntityTerms(hoverReference.entity_terms).length > 0 && (
            <div className="entity-terms">
              {normalizeEntityTerms(hoverReference.entity_terms).map((term) => (
                <span key={`${hoverReference.reference_id}-hover-${term}`} className="entity-chip">
                  {term}
                </span>
              ))}
            </div>
          )}
          <div className="floating-reference-content">
            {(hoverReference.content ?? ['当前引用未包含 chunk 内容。']).map((snippet, index) => (
              <blockquote key={`${hoverReference.reference_id}-hover-${index}`}>
                {snippetParagraphs(snippet).map((paragraph, paragraphIndex) => (
                  <p key={`${hoverReference.reference_id}-hover-${index}-${paragraphIndex}`}>
                    {highlightEntityTerms(paragraph, hoverReference.entity_terms)}
                  </p>
                ))}
              </blockquote>
            ))}
          </div>
        </div>
      )}

      {touchReference && touchMessageReference && (
        <div className="mobile-reference-sheet" onClick={() => setTouchReference(null)}>
          <div className="sheet-body" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-header">
              <div>
                <p className="reference-badge">[{touchMessageReference.reference_id}]</p>
                <h3>{summarizePath(touchMessageReference.file_path)}</h3>
              </div>
              <button
                type="button"
                className="sheet-close"
                onClick={() => setTouchReference(null)}
                aria-label="关闭"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {normalizeEntityTerms(touchMessageReference.entity_terms).length > 0 && (
              <div className="entity-terms">
                {normalizeEntityTerms(touchMessageReference.entity_terms).map((term) => (
                  <span key={`${touchMessageReference.reference_id}-touch-${term}`} className="entity-chip">
                    {term}
                  </span>
                ))}
              </div>
            )}
            <div className="sheet-content">
              {(touchMessageReference.content ?? ['当前引用未包含 chunk 内容。']).map((snippet, index) => (
                <blockquote key={`${touchMessageReference.reference_id}-touch-${index}`}>
                  {snippetParagraphs(snippet).map((paragraph, paragraphIndex) => (
                    <p key={`${touchMessageReference.reference_id}-touch-${index}-${paragraphIndex}`}>
                      {highlightEntityTerms(paragraph, touchMessageReference.entity_terms)}
                    </p>
                  ))}
                </blockquote>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
