import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { streamQuery } from './api/lightrag'
import { createSpeechAsrSocket, synthesizeSpeech } from './api/speech'
import {
  convertAudioFileToPCMChunks,
  getAudioProcessingSupportError,
  getPCMRecorderSupportError,
  startPCMRecorder
} from './lib/pcmRecorder'
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

const STARTER_PROMPT_DECKS = [
  {
    label: '入门发问',
    prompts: [
      '做梦好不好？',
      '修炼的重点是什么？',
      '什么是性命双修？',
      '玄德是什么？',
      '为什么自性为师很重要？',
      '什么是清净？',
      '元神是什么？',
      '什么是“反者道之动”？'
    ]
  },
  {
    label: '修持辨析',
    prompts: [
      '为什么越修越容易看到自己的执著？',
      '先天意识和后天意识有什么不同？',
      '无为是不是等于什么都不做？',
      '为什么修行里常说要观照自己？',
      '如何理解修炼中的真假、虚实？',
      '为什么懂了很多道理，志向却还是立不起来？',
      '如何理解返观内照？',
      '道和德之间是什么关系？'
    ]
  },
  {
    label: '经典切入',
    prompts: [
      '《道德经》里讲“柔弱胜刚强”应该怎么理解？',
      '“上善若水”对修行意味着什么？',
      '《黄庭内景经》主要在讲什么？',
      '如何理解“致虚极，守静笃”？',
      '什么叫“知其白，守其黑”？',
      '“反者道之动”在修持中怎么体现？',
      '经典里说的“抱一”是什么意思？',
      '什么叫“功夫要落在身心上”？'
    ]
  }
]

const STARTER_PROMPT_COUNT = 6

const summarizePath = (filePath: string) => {
  const pieces = filePath.split('/').filter(Boolean)
  const filename = pieces.at(-1) ?? filePath
  return filename.replace(/\.[^.]+$/, '')
}

const summarizeQuestion = (text: string) => {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > 28 ? `${singleLine.slice(0, 28)}...` : singleLine
}

const shuffle = <T,>(items: T[]) => {
  const next = [...items]

  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[next[index], next[swapIndex]] = [next[swapIndex], next[index]]
  }

  return next
}

const pickStarterPromptDeck = () => {
  const deck =
    STARTER_PROMPT_DECKS[Math.floor(Math.random() * STARTER_PROMPT_DECKS.length)]
  return {
    label: deck.label,
    prompts: shuffle(deck.prompts).slice(0, STARTER_PROMPT_COUNT)
  }
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

const splitSpeechSegments = (text: string, maxChars = 120) => {
  const normalized = toSpeakableText(text)
  if (!normalized) {
    return []
  }

  const sentences = normalized
    .split(/(?<=[。！？!?；;])\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const source = sentences.length > 0 ? sentences : [normalized]
  const segments: string[] = []
  let current = ""

  for (const sentence of source) {
    if (!current) {
      current = sentence
      continue
    }

    if (current.length + sentence.length <= maxChars) {
      current += sentence
      continue
    }

    segments.push(current)
    current = sentence
  }

  if (current) {
    segments.push(current)
  }

  return segments.flatMap((segment) => {
    if (segment.length <= maxChars * 1.5) {
      return [segment]
    }

    const chunks: string[] = []
    for (let index = 0; index < segment.length; index += maxChars) {
      chunks.push(segment.slice(index, index + maxChars))
    }
    return chunks
  })
}

const referenceSpeakableText = (reference: ReferenceItem) => {
  const title = summarizePath(reference.file_path)
  const snippets = (reference.content ?? [])
    .flatMap((snippet) => normalizeSnippet(snippet))
    .filter(Boolean)

  return toSpeakableText(
    [title ? `参考材料 ${title}` : '', snippets.join(' ')].filter(Boolean).join('。 ')
  )
}

const ANSWER_DISCLAIMER =
  '以上AI解答仅作参考。最终要以厚音老师的本人的回答为准。'

type AnswerSectionKey = 'body' | 'references' | 'followups'
type StaticMarkupRenderer = typeof import('react-dom/server').renderToStaticMarkup

const matchAnswerSectionHeading = (line: string): AnswerSectionKey | null => {
  const match = line.match(/^#{1,6}\s*(.+?)\s*$/)
  if (!match) {
    return null
  }

  const heading = match[1].trim().toLocaleLowerCase('zh-CN')

  if (heading === 'references' || heading === '参考资料') {
    return 'references'
  }

  if (heading === '延伸追问') {
    return 'followups'
  }

  return null
}

const extractFollowupQuestions = (markdown: string) =>
  markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)

const splitAnswerSections = (content: string) => {
  const sections: Record<AnswerSectionKey, string[]> = {
    body: [],
    references: [],
    followups: []
  }

  let currentSection: AnswerSectionKey = 'body'

  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const matchedSection = matchAnswerSectionHeading(line)
    if (matchedSection) {
      currentSection = matchedSection
      continue
    }

    sections[currentSection].push(line)
  }

  return {
    body: sections.body.join('\n').trim(),
    referencesMarkdown: sections.references.join('\n').trim(),
    followupQuestions: extractFollowupQuestions(sections.followups.join('\n'))
  }
}

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

const getMessageQuestion = (messages: ChatMessage[], messageId: string) => {
  const messageIndex = messages.findIndex((message) => message.id === messageId)
  if (messageIndex <= 0) {
    return ''
  }

  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return messages[index].content.trim()
    }
  }

  return ''
}

const buildReferenceLines = (references?: ReferenceItem[]) => {
  if (!references || references.length === 0) {
    return []
  }

  return references.flatMap((reference) => {
    const paragraphs = (reference.content ?? [])
      .flatMap((snippet) => snippetParagraphs(snippet))
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)

    if (paragraphs.length === 0) {
      return [`[${reference.reference_id}] ${summarizePath(reference.file_path)}`]
    }

    return [
      `[${reference.reference_id}] ${summarizePath(reference.file_path)}`,
      ...paragraphs.map((paragraph) => `  ${paragraph}`)
    ]
  })
}

const referenceSortValue = (reference: ReferenceItem) => {
  const numericId = Number.parseInt(reference.reference_id, 10)
  return Number.isNaN(numericId) ? Number.MAX_SAFE_INTEGER : numericId
}

const sortReferences = (references?: ReferenceItem[]) =>
  [...(references ?? [])].sort((left, right) => {
    const idDiff = referenceSortValue(left) - referenceSortValue(right)
    if (idDiff !== 0) {
      return idDiff
    }

    return left.reference_id.localeCompare(right.reference_id, 'zh-CN')
  })

const buildAnswerExportText = (question: string, message: ChatMessage) => {
  const sections = splitAnswerSections(stripKnownFileExtensions(message.content))
  const references = buildReferenceLines(message.references)

  return [
    question ? `问题\n${question}` : '',
    sections.body ? `回答\n${toSpeakableText(sections.body)}` : '',
    references.length > 0 ? `参考资料\n${references.join('\n')}` : '',
    ANSWER_DISCLAIMER
  ]
    .filter(Boolean)
    .join('\n\n')
}

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const encodeSharePayload = (payload: unknown) => {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

const decodeSharePayload = (encoded: string) => {
  const normalized = encoded
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const binary = atob(normalized)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))

  return JSON.parse(new TextDecoder().decode(bytes)) as {
    question: string
    answer: string
    references?: ReferenceItem[]
    createdAt: number
  }
}

const getCitationIds = (value: unknown) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : []

const renderMarkdownForPrint = (
  renderToStaticMarkup: StaticMarkupRenderer,
  markdown: string,
  references?: ReferenceItem[]
) => {
  if (!markdown.trim()) {
    return ''
  }

  const referenceIds = new Set((references ?? []).map((reference) => reference.reference_id))
  const printMarkdownComponents = {
    'citation-ref': (props: Record<string, unknown>) => {
      const ids = getCitationIds(props['data-ids'])

      return (
        <sup className="print-citation">
          {ids.map((id) => (
            <span
              key={id}
              className={referenceIds.size > 0 && !referenceIds.has(id) ? 'missing' : undefined}
            >
              [{id}]
            </span>
          ))}
        </sup>
      )
    },
    p: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    ul: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol>{children}</ol>
  }

  return renderToStaticMarkup(
    <div className="print-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCitations]}
        rehypePlugins={[rehypeRaw]}
        components={printMarkdownComponents}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

const buildStructuredReferencesHtml = (references?: ReferenceItem[]) => {
  const orderedReferences = sortReferences(references)
  if (orderedReferences.length === 0) {
    return ''
  }

  return orderedReferences
    .map((reference) => {
      const paragraphs = (reference.content ?? [])
        .flatMap((snippet) => snippetParagraphs(snippet))
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
      const title = summarizePath(reference.file_path)
      const body =
        paragraphs.length > 0
          ? paragraphs
              .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
              .join('')
          : '<p class="reference-empty">当前引用未包含 chunk 内容。</p>'

      return `<article class="reference-entry">
        <h3><span>[${escapeHtml(reference.reference_id)}]</span>${escapeHtml(title)}</h3>
        ${body}
      </article>`
    })
    .join('')
}

const buildPrintableHtml = (
  renderToStaticMarkup: StaticMarkupRenderer,
  question: string,
  message: ChatMessage
) => {
  const sections = splitAnswerSections(stripKnownFileExtensions(message.content))
  const answerHtml = renderMarkdownForPrint(
    renderToStaticMarkup,
    sections.body || message.content,
    message.references
  )
  const referencesHtml = renderMarkdownForPrint(
    renderToStaticMarkup,
    sections.referencesMarkdown,
    message.references
  )
  const structuredReferencesHtml = buildStructuredReferencesHtml(message.references)

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(summarizeQuestion(question || '玄德问答'))}</title>
  <style>
    @page { margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: #111;
      background: #fff;
      font: 16px/1.9 "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    main {
      max-width: 860px;
      margin: 0 auto;
      padding: 28px 24px;
      background: #fff;
    }
    h1 {
      margin: 0 0 22px;
      color: #111;
      font: 700 28px/1.35 "Songti SC", "STSong", "SimSun", serif;
    }
    section {
      break-inside: avoid-page;
    }
    section + section {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #ddd;
    }
    .label {
      margin: 0 0 14px;
      color: #111;
      font-size: 18px;
      font-weight: 700;
      line-height: 1.45;
    }
    .question {
      white-space: pre-wrap;
      line-height: 1.9;
    }
    .print-markdown {
      color: #111;
      line-height: 1.95;
    }
    .print-markdown p {
      margin: 0 0 1.05em;
    }
    .print-markdown h1,
    .print-markdown h2,
    .print-markdown h3,
    .print-markdown h4 {
      color: #111;
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-weight: 700;
      line-height: 1.45;
      break-after: avoid;
    }
    .print-markdown h1 { margin: 1.35em 0 0.65em; font-size: 24px; }
    .print-markdown h2 { margin: 1.25em 0 0.6em; font-size: 22px; }
    .print-markdown h3 { margin: 1.15em 0 0.55em; font-size: 20px; }
    .print-markdown h4 { margin: 1.05em 0 0.5em; font-size: 18px; }
    .print-markdown strong,
    .print-markdown b {
      color: #111;
      font-weight: 800;
    }
    .print-markdown ul,
    .print-markdown ol {
      margin: 0.9em 0 1.2em 1.5em;
      padding: 0;
    }
    .print-markdown li {
      margin: 0.42em 0;
      padding-left: 0.2em;
    }
    .print-markdown blockquote {
      margin: 1.1em 0;
      padding: 0.2em 0 0.2em 1em;
      border-left: 3px solid #bbb;
      color: #222;
    }
    .print-markdown code {
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.92em;
    }
    .print-markdown pre {
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      border: 1px solid #ddd;
      padding: 12px;
    }
    .print-markdown table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.2em 0;
      font-size: 14px;
    }
    .print-markdown th,
    .print-markdown td {
      border: 1px solid #ccc;
      padding: 8px 10px;
      vertical-align: top;
    }
    .print-markdown th {
      font-weight: 700;
    }
    .print-citation {
      margin: 0 0.12em;
      vertical-align: super;
      font-size: 0.72em;
      line-height: 0;
      color: #111;
      font-weight: 800;
    }
    .print-citation span + span {
      margin-left: 0.16em;
    }
    .print-citation .missing {
      color: #9f1239;
    }
    .reference-entry {
      margin: 0 0 24px;
      padding-bottom: 18px;
      border-bottom: 1px solid #e4e4e4;
      break-inside: avoid-page;
    }
    .reference-entry:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .reference-entry h3 {
      margin: 0 0 10px;
      color: #111;
      font-size: 19px;
      font-weight: 800;
      line-height: 1.45;
    }
    .reference-entry h3 span {
      display: inline-block;
      margin-right: 0.55em;
      font-weight: 900;
    }
    .reference-entry p {
      margin: 0.45em 0 0;
      color: #222;
      line-height: 1.85;
    }
    .reference-empty {
      color: #666;
    }
    .disclaimer {
      margin-top: 30px;
      color: #444;
      font-size: 14px;
      line-height: 1.8;
    }
    @media print {
      body { background: #fff; }
      main { max-width: none; padding: 0; }
    }
  </style>
</head>
<body>
  <main>
    <h1>玄德问答</h1>
    ${question ? `<section><p class="label">问题</p><div class="question">${escapeHtml(question)}</div></section>` : ''}
    <section><p class="label">回答</p>${answerHtml}</section>
    ${referencesHtml ? `<section><p class="label">References</p>${referencesHtml}</section>` : ''}
    ${structuredReferencesHtml ? `<section><p class="label">引用原文</p>${structuredReferencesHtml}</section>` : ''}
    <p class="disclaimer">${escapeHtml(ANSWER_DISCLAIMER)}</p>
  </main>
</body>
</html>`
}

const fallbackCopyText = (text: string) => {
  const textarea = document.createElement('textarea')
  const selection = window.getSelection()
  const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'

  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }

  document.body.removeChild(textarea)

  if (selection) {
    selection.removeAllRanges()
    if (originalRange) {
      selection.addRange(originalRange)
    }
  }

  return copied
}

const copyTextWithFallback = async (text: string) => {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return fallbackCopyText(text)
    }
  }

  return fallbackCopyText(text)
}

const openManualCopyPrompt = (label: string, text: string) => {
  window.prompt(label, text)
}

const isMobileBrowser = () =>
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
    navigator.userAgent
  )

const downloadTextFile = (filename: string, content: string, mimeType: string) => {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 60_000)
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
  relatedQuestion: string
  isSpeaking: boolean
  isSpeechLoading: boolean
  isSpeechReady: boolean
  isSubmitting: boolean
  onHoverReferenceStart: (referenceId: string, messageId: string, anchorRect: DOMRect) => void
  onHoverReferenceEnd: () => void
  onSelectReference: (referenceId: string, messageId: string) => void
  onToggleSpeak: (message: ChatMessage) => void
  onAskFollowup: (question: string) => void
  onCopy: (message: ChatMessage, relatedQuestion: string) => void
  onShare: (message: ChatMessage, relatedQuestion: string) => void
  onDownloadPdf: (message: ChatMessage, relatedQuestion: string) => void
}

const MessageCard = ({
  message,
  relatedQuestion,
  isSpeaking,
  isSpeechLoading,
  isSpeechReady,
  isSubmitting,
  onHoverReferenceStart,
  onHoverReferenceEnd,
  onSelectReference,
  onToggleSpeak,
  onAskFollowup,
  onCopy,
  onShare,
  onDownloadPdf
}: MessageCardProps) => {
  const displayContent =
    message.role === 'assistant' ? stripKnownFileExtensions(message.content) : message.content
  const structuredAnswer =
    message.role === 'assistant' && !message.isStreaming && !message.error
      ? splitAnswerSections(displayContent)
      : null

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

  const answerBody = structuredAnswer?.body || displayContent
  const referencesMarkdown = structuredAnswer?.referencesMarkdown ?? ''
  const followupQuestions = structuredAnswer?.followupQuestions ?? []

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
          <>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkCitations]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {answerBody || (message.isStreaming ? '请稍候...' : '')}
            </ReactMarkdown>
            {followupQuestions.length > 0 && (
              <section className="message-section followup-section">
                <h3 className="message-section-title">延伸追问</h3>
                <div className="followup-list">
                  {followupQuestions.map((followupQuestion) => (
                    <button
                      key={`${message.id}-${followupQuestion}`}
                      type="button"
                      className="followup-button"
                      onClick={() => onAskFollowup(followupQuestion)}
                      disabled={isSubmitting}
                    >
                      {followupQuestion}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {referencesMarkdown && (
              <section className="message-section">
                <h3 className="message-section-title">References</h3>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkCitations]}
                  rehypePlugins={[rehypeRaw]}
                  components={markdownComponents}
                >
                  {referencesMarkdown}
                </ReactMarkdown>
              </section>
            )}
            {shouldShowDisclaimer && (
              <>
                <p className="answer-disclaimer">{ANSWER_DISCLAIMER}</p>
                <div className="message-action-row">
                  <button
                    type="button"
                    className={`message-audio-button ${isSpeaking ? 'active' : ''}`}
                    onClick={() => onToggleSpeak(message)}
                    disabled={isSpeechLoading && !isSpeaking}
                  >
                    <span aria-hidden="true">📢</span>
                    {isSpeechLoading && !isSpeaking
                      ? '朗读准备中…'
                      : isSpeaking
                        ? '停止朗读'
                        : isSpeechReady
                          ? '点击播放'
                          : '朗读'}
                  </button>
                  <button
                    type="button"
                    className="message-utility-button"
                    onClick={() => onShare(message, relatedQuestion)}
                  >
                    <span aria-hidden="true">🔗</span>
                    分享
                  </button>
                  <button
                    type="button"
                    className="message-utility-button"
                    onClick={() => onDownloadPdf(message, relatedQuestion)}
                  >
                    <span aria-hidden="true">🗎</span>
                    PDF
                  </button>
                  <button
                    type="button"
                    className="message-utility-button"
                    onClick={() => onCopy(message, relatedQuestion)}
                  >
                    <span aria-hidden="true">⧉</span>
                    复制
                  </button>
                </div>
              </>
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
  const [isUploadingAudio, setIsUploadingAudio] = useState(false)
  const [speechError, setSpeechError] = useState('')
  const [uiStatus, setUiStatus] = useState<{ tone: 'error' | 'success'; text: string } | null>(
    null
  )
  const [speechLoadingTarget, setSpeechLoadingTarget] = useState<string | null>(null)
  const [playingAudioTarget, setPlayingAudioTarget] = useState<string | null>(null)
  const [pendingPlaybackTarget, setPendingPlaybackTarget] = useState<string | null>(null)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [starterPromptDeck, setStarterPromptDeck] = useState(() => pickStarterPromptDeck())
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
  const audioTargetRef = useRef<string | null>(null)
  const speechRunIdRef = useRef(0)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const audioUploadInputRef = useRef<HTMLInputElement | null>(null)
  const hoverShowTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const hoverHideTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const uiStatusTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const voiceInputSupportError = getPCMRecorderSupportError()
  const audioUploadSupportError = getAudioProcessingSupportError()

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
    const hash = window.location.hash.startsWith('#share=')
      ? window.location.hash.slice('#share='.length)
      : ''

    if (!hash) {
      return
    }

    try {
      const payload = decodeSharePayload(hash)
      const sharedSessionId = `shared-${payload.createdAt}`
      const sharedSession: ChatSession = {
        id: sharedSessionId,
        title: summarizeQuestion(payload.question || '分享问答'),
        updatedAt: payload.createdAt,
        messages: [
          {
            id: `${sharedSessionId}-question`,
            role: 'user',
            content: payload.question,
            createdAt: payload.createdAt
          },
          {
            id: `${sharedSessionId}-answer`,
            role: 'assistant',
            content: payload.answer,
            references: payload.references ?? [],
            createdAt: payload.createdAt + 1
          }
        ]
      }

      setSessions((current) => {
        const filtered = current.filter((session) => session.id !== sharedSessionId)
        return [sharedSession, ...filtered]
      })
      setCurrentSessionId(sharedSessionId)
      setUiStatus({ tone: 'success', text: '已打开分享问答。' })
    } catch {
      setUiStatus({ tone: 'error', text: '分享内容无法解析。' })
    }
  }, [])

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

      if (uiStatusTimerRef.current !== null) {
        window.clearTimeout(uiStatusTimerRef.current)
      }
    }
  }, [])

  const showUiStatus = (text: string, tone: 'error' | 'success' = 'success') => {
    if (uiStatusTimerRef.current !== null) {
      window.clearTimeout(uiStatusTimerRef.current)
    }

    setUiStatus({ tone, text })
    uiStatusTimerRef.current = window.setTimeout(() => {
      setUiStatus(null)
      uiStatusTimerRef.current = null
    }, 3200)
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
    audioTargetRef.current = null
    setPlayingAudioTarget(null)
    setPendingPlaybackTarget(null)
    setSpeechLoadingTarget(null)
    setIsRecording(false)
    setSpeechError('')
    setUiStatus(null)
    setCurrentSessionId(null)
    setQuestion('')
    setIsSubmitting(false)
    setHoverPreview(null)
    setTouchReference(null)
    setMobileDrawerOpen(false)
  }

  const stopSpeaking = (cancelPlayback = true) => {
    if (cancelPlayback) {
      speechRunIdRef.current += 1
    }

    if (audioRef.current) {
      audioRef.current.pause()
    }

    setPlayingAudioTarget(null)
    setSpeechLoadingTarget(null)
  }

  const pauseSpeaking = () => {
    speechRunIdRef.current += 1

    if (audioRef.current) {
      audioRef.current.pause()
    }

    setPlayingAudioTarget(null)
    setSpeechLoadingTarget(null)
  }

  const clearSpeechAudio = () => {
    speechRunIdRef.current += 1

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }

    audioTargetRef.current = null
    setPlayingAudioTarget(null)
    setSpeechLoadingTarget(null)
    setPendingPlaybackTarget(null)
  }

  const releaseCurrentAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
  }

  const attachSpeechAudioHandlers = (
    audio: HTMLAudioElement,
    target: string,
    onEnded?: () => void
  ) => {
    audio.onended = onEnded ?? (() => {
      stopSpeaking(false)
      setPendingPlaybackTarget(target)
    })
    audio.onerror = () => {
      setSpeechError('语音播放失败。')
      clearSpeechAudio()
    }
  }

  const createSpeechAudio = (target: string, blob: Blob, onEnded?: () => void) => {
    releaseCurrentAudio()
    const audioUrl = URL.createObjectURL(blob)
    const audio = new Audio(audioUrl)
    audioRef.current = audio
    audioUrlRef.current = audioUrl
    audioTargetRef.current = target
    attachSpeechAudioHandlers(audio, target, onEnded)
    return audio
  }

  const tryPlaySpeechAudio = async (target: string, blockedMessage: string) => {
    const audio = audioRef.current
    if (!audio || audioTargetRef.current !== target) {
      return false
    }

    try {
      audio.currentTime = 0
      await audio.play()
      setPlayingAudioTarget(target)
      setPendingPlaybackTarget(null)
      setSpeechError('')
      return true
    } catch {
      setPlayingAudioTarget(null)
      setPendingPlaybackTarget(target)
      setSpeechError(blockedMessage)
      return false
    }
  }

  const fetchSpeechSegment = (segment: string) =>
    synthesizeSpeech(config.baseUrl, segment, {
      apiKey: config.apiKey,
      bearerToken: config.bearerToken
    })

  const playSpeechSegments = async (target: string, segments: string[]) => {
    const runId = speechRunIdRef.current
    let nextBlobPromise: Promise<Blob> | null = fetchSpeechSegment(segments[0])

    for (let index = 0; index < segments.length; index += 1) {
      if (speechRunIdRef.current !== runId) {
        return
      }

      const blob = await nextBlobPromise
      nextBlobPromise =
        index + 1 < segments.length ? fetchSpeechSegment(segments[index + 1]) : null

      if (speechRunIdRef.current !== runId) {
        return
      }

      const isLastSegment = index === segments.length - 1
      const audio = createSpeechAudio(target, blob, () => {
        if (isLastSegment) {
          clearSpeechAudio()
        }
      })

      const played = await tryPlaySpeechAudio(
        target,
        index === 0 ? '语音已生成，请再点一次播放。' : '语音播放被浏览器拦截，请再点一次播放。'
      )

      if (!played) {
        return
      }

      if (!isLastSegment) {
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve()
          audio.onerror = () => reject(new Error('语音播放失败。'))
        })
      }
    }
  }

  const playSpeechText = async (
    target: string,
    text: string,
    emptyMessage: string
  ) => {
    if (playingAudioTarget === target) {
      pauseSpeaking()
      return
    }

    if (pendingPlaybackTarget === target && audioRef.current && audioTargetRef.current === target) {
      await tryPlaySpeechAudio(target, '语音已准备好，请再点一次播放。')
      return
    }

    clearSpeechAudio()
    setSpeechError('')
    setSpeechLoadingTarget(target)

    try {
      const speechSegments = splitSpeechSegments(text)
      if (speechSegments.length === 0) {
        throw new Error(emptyMessage)
      }

      speechRunIdRef.current += 1
      await playSpeechSegments(target, speechSegments)
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : '语音合成失败。')
      clearSpeechAudio()
    } finally {
      setSpeechLoadingTarget((current) => (current === target ? null : current))
    }
  }

  const handleToggleSpeak = async (message: ChatMessage) => {
    await playSpeechText(
      `message:${message.id}`,
      message.content,
      '当前回答没有可朗读的内容。'
    )
  }

  const handleToggleReferenceSpeak = async (
    messageId: string,
    reference: ReferenceItem
  ) => {
    await playSpeechText(
      `reference:${messageId}:${reference.reference_id}`,
      referenceSpeakableText(reference),
      '当前引用没有可朗读的内容。'
    )
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

  const transcribeAudioChunks = async (chunks: ArrayBuffer[]) => {
    const socket = createSpeechAsrSocket(config.baseUrl, {
      apiKey: config.apiKey,
      bearerToken: config.bearerToken
    })
    socket.binaryType = 'arraybuffer'

    return await new Promise<string>((resolve, reject) => {
      let transcript = ''
      let completed = false

      const finish = (value?: string, error?: Error) => {
        if (completed) {
          return
        }

        completed = true
        socket.close()

        if (error) {
          reject(error)
          return
        }

        resolve((value ?? transcript).trim())
      }

      socket.onopen = () => {
        // Wait for backend ready signal before sending audio.
      }

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

        if (payload.type === 'ready') {
          for (const chunk of chunks) {
            socket.send(chunk)
          }
          socket.send(JSON.stringify({ type: 'end' }))
          return
        }

        if (payload.type === 'transcript' && typeof payload.text === 'string') {
          transcript = payload.text
          if (payload.is_final) {
            finish(transcript)
          }
          return
        }

        if (payload.type === 'error') {
          finish(undefined, new Error(payload.message ?? '语音识别失败。'))
        }
      }

      socket.onerror = () => {
        finish(undefined, new Error('语音识别连接失败。'))
      }

      socket.onclose = () => {
        if (completed) {
          return
        }

        if (transcript.trim()) {
          finish(transcript)
          return
        }

        finish(undefined, new Error('未识别到有效语音内容。'))
      }
    })
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

  const handleAudioUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    if (audioUploadSupportError) {
      setSpeechError(audioUploadSupportError)
      return
    }

    if (isRecording) {
      await stopVoiceInput()
    }

    stopSpeaking()
    setSpeechError('')
    setIsUploadingAudio(true)

    try {
      const chunks = await convertAudioFileToPCMChunks(file)
      const transcript = await transcribeAudioChunks(chunks)

      if (!transcript) {
        throw new Error('未识别到有效语音内容。')
      }

      setQuestion(transcript)
      resizeTextarea(transcript)
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : '音频识别失败。')
    } finally {
      setIsUploadingAudio(false)
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

  const handleCopyAnswer = async (message: ChatMessage, relatedQuestion: string) => {
    const exportText = buildAnswerExportText(relatedQuestion, message)

    try {
      const copied = await copyTextWithFallback(exportText)
      if (copied) {
        showUiStatus('已复制这一问一答。')
        return
      }
    } catch {
      // Fall through to manual download/prompt fallback.
    }

    downloadTextFile(`玄德问答-${Date.now()}.txt`, exportText, 'text/plain')
    showUiStatus('浏览器复制受限，已下载文本文件。', 'success')
  }

  const handleShareAnswer = async (message: ChatMessage, relatedQuestion: string) => {
    const sections = splitAnswerSections(stripKnownFileExtensions(message.content))
    const payload = encodeSharePayload({
      question: relatedQuestion,
      answer: sections.body || message.content,
      references: message.references ?? [],
      createdAt: message.createdAt
    })
    const shareUrl = new URL(window.location.href)
    shareUrl.hash = `share=${payload}`
    const shareText = buildAnswerExportText(relatedQuestion, message)

    try {
      if (navigator.share && window.isSecureContext) {
        await navigator.share({
          title: summarizeQuestion(relatedQuestion || '玄德问答'),
          text: shareText,
          url: shareUrl.toString()
        })
        showUiStatus('分享面板已打开。')
        return
      }

      const copied = await copyTextWithFallback(shareUrl.toString())
      if (copied) {
        showUiStatus('分享链接已复制。')
        return
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }
    }

    openManualCopyPrompt('请复制以下分享链接', shareUrl.toString())
    showUiStatus('已生成分享链接，请手动复制。')
  }

  const handleDownloadPdf = async (message: ChatMessage, relatedQuestion: string) => {
    const filename = `玄德问答-${Date.now()}.html`
    const { renderToStaticMarkup } = await import('react-dom/server')
    const printableHtml = buildPrintableHtml(renderToStaticMarkup, relatedQuestion, message)
    const htmlBlob = new Blob([printableHtml], { type: 'text/html;charset=utf-8' })
    const htmlUrl = URL.createObjectURL(htmlBlob)
    const exportWindow = window.open(htmlUrl, '_blank')

    if (exportWindow) {
      if (!isMobileBrowser()) {
        window.setTimeout(() => {
          exportWindow.focus()
          exportWindow.print()
        }, 400)
        showUiStatus('已打开导出页，可打印为 PDF。')
      } else {
        showUiStatus('已打开导出页，请用浏览器菜单另存或分享。')
      }

      window.setTimeout(() => {
        URL.revokeObjectURL(htmlUrl)
      }, 60_000)
      return
    }

    try {
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF({
        orientation: 'p',
        unit: 'pt',
        format: 'a4'
      })
      const lines = pdf.splitTextToSize(buildAnswerExportText(relatedQuestion, message), 520)
      let cursorY = 56

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(12)

      lines.forEach((line: string) => {
        if (cursorY > 790) {
          pdf.addPage()
          cursorY = 56
        }
        pdf.text(line, 40, cursorY)
        cursorY += 18
      })

      pdf.save(`玄德问答-${Date.now()}.pdf`)
      showUiStatus('PDF 已开始下载。')
      URL.revokeObjectURL(htmlUrl)
      return
    } catch {
      URL.revokeObjectURL(htmlUrl)
    }

    downloadTextFile(filename, printableHtml, 'text/html')
    showUiStatus('已下载导出页，请在浏览器中打开后另存为 PDF。')
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
              <div className="empty-prompt-header">
                <p>本次引子：{starterPromptDeck.label}</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setStarterPromptDeck(pickStarterPromptDeck())}
                >
                  换一组
                </button>
              </div>
              <div className="empty-prompt-grid">
                {starterPromptDeck.prompts.map((prompt) => (
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
                relatedQuestion={getMessageQuestion(messages, message.id)}
                isSpeaking={playingAudioTarget === `message:${message.id}`}
                isSpeechLoading={speechLoadingTarget === `message:${message.id}`}
                isSpeechReady={pendingPlaybackTarget === `message:${message.id}`}
                isSubmitting={isSubmitting}
                onHoverReferenceStart={handleHoverReferenceStart}
                onHoverReferenceEnd={handleHoverReferenceEnd}
                onSelectReference={handleSelectReference}
                onToggleSpeak={handleToggleSpeak}
                onAskFollowup={(followupQuestion) => void submitQuestion(followupQuestion)}
                onCopy={handleCopyAnswer}
                onShare={handleShareAnswer}
                onDownloadPdf={handleDownloadPdf}
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
            {speechError ? (
              <p className="composer-status composer-error">{speechError}</p>
            ) : uiStatus ? (
              <p
                className={`composer-status ${
                  uiStatus.tone === 'error' ? 'composer-error' : 'composer-success'
                }`}
              >
                {uiStatus.text}
              </p>
            ) : (
              <span />
            )}
            <div className="composer-actions">
              <input
                ref={audioUploadInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.aac,.webm,.ogg"
                style={{ display: 'none' }}
                onChange={(event) => void handleAudioUpload(event)}
              />
              <button
                type="button"
                className="secondary-action"
                onClick={() => audioUploadInputRef.current?.click()}
                disabled={isSubmitting || isRecording || isUploadingAudio || Boolean(audioUploadSupportError)}
                title={audioUploadSupportError ?? undefined}
              >
                {isUploadingAudio ? '识别中…' : '上传音频'}
              </button>
              <button
                type="button"
                className={`secondary-action mic-action ${isRecording ? 'recording' : ''}`}
                onClick={() => void startVoiceInput()}
                disabled={
                  isSubmitting ||
                  isUploadingAudio ||
                  (!isRecording && Boolean(voiceInputSupportError))
                }
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
          <div className="reference-preview-header">
            <div>
              <p className="reference-badge">[{hoverReference.reference_id}]</p>
              <h4>{summarizePath(hoverReference.file_path)}</h4>
            </div>
            <button
              type="button"
              className={`message-audio-button ${playingAudioTarget === `reference:${hoverMessage.id}:${hoverReference.reference_id}` ? 'active' : ''}`}
              onClick={() => void handleToggleReferenceSpeak(hoverMessage.id, hoverReference)}
              disabled={
                speechLoadingTarget === `reference:${hoverMessage.id}:${hoverReference.reference_id}` &&
                playingAudioTarget !== `reference:${hoverMessage.id}:${hoverReference.reference_id}`
              }
            >
              <span aria-hidden="true">📢</span>
              {speechLoadingTarget === `reference:${hoverMessage.id}:${hoverReference.reference_id}` &&
              playingAudioTarget !== `reference:${hoverMessage.id}:${hoverReference.reference_id}`
                ? '朗读准备中…'
                : playingAudioTarget === `reference:${hoverMessage.id}:${hoverReference.reference_id}`
                  ? '停止朗读'
                  : pendingPlaybackTarget === `reference:${hoverMessage.id}:${hoverReference.reference_id}`
                    ? '点击播放'
                    : '朗读'}
            </button>
          </div>
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
              <div className="sheet-actions">
                <button
                  type="button"
                  className={`message-audio-button ${playingAudioTarget === `reference:${touchMessage.id}:${touchMessageReference.reference_id}` ? 'active' : ''}`}
                  onClick={() => void handleToggleReferenceSpeak(touchMessage.id, touchMessageReference)}
                  disabled={
                    speechLoadingTarget === `reference:${touchMessage.id}:${touchMessageReference.reference_id}` &&
                    playingAudioTarget !== `reference:${touchMessage.id}:${touchMessageReference.reference_id}`
                  }
                >
                  <span aria-hidden="true">📢</span>
                  {speechLoadingTarget === `reference:${touchMessage.id}:${touchMessageReference.reference_id}` &&
                  playingAudioTarget !== `reference:${touchMessage.id}:${touchMessageReference.reference_id}`
                    ? '朗读准备中…'
                    : playingAudioTarget === `reference:${touchMessage.id}:${touchMessageReference.reference_id}`
                      ? '停止朗读'
                      : pendingPlaybackTarget === `reference:${touchMessage.id}:${touchMessageReference.reference_id}`
                        ? '点击播放'
                        : '朗读'}
                </button>
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
