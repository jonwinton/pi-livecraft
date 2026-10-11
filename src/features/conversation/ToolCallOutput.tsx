import {
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { canHighlightFile } from './file-preview.ts'
import { Markdown } from './Markdown.tsx'
import { csvSourcePreview, parseCsvPreview, type CsvPreview } from './csv-preview.ts'
import { ToolCallEditDiff } from './ToolCallEditDiff.tsx'
import {
  parseEditDiff,
  readContentDisplay,
  readStartingLineNumber,
  stripScripts,
  toolEditChanges,
  toolFilePath,
} from './tool-presentation.ts'

/**
 * Blocks every network fetch from previewed HTML so it cannot load or beacon remote URLs.
 * It is inserted after any doctype so the preview keeps standards mode.
 */
const htmlPreviewPolicy =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:">`

const LazyCodeHighlighter = lazy(() => import('./CodeHighlighter'))

const lineNumberStyle: CSSProperties = {
  minWidth: '2.5em',
  paddingRight: '1em',
  textAlign: 'right',
  userSelect: 'none',
  opacity: 0.5,
}

/** Renders preformatted content with line numbers starting at an arbitrary offset. */
function NumberedPre({ content, startLine }: { content: string; startLine: number }) {
  const lines = content.split('\n')
  const displayLines = content.endsWith('\n') ? lines.slice(0, -1) : lines
  const width = String(startLine + displayLines.length - 1).length
  return (
    <pre className='tool-call-numbered-pre'>
    {displayLines.map((line, i) => {
      const num = startLine + i
      return <div key={i}><span>{String(num).padStart(width)}</span>{line}</div>
    })}
    </pre>
  )
}

/** Displays a clickable preview and retains its measured footprint while its expensive content is offscreen. */
export function ToolCallPreview({
  call,
  content,
  isNearViewport,
  onClick,
  previewText,
  remainingLineCount,
  showHtmlPreview,
}: {
  call: { name: string; args: unknown }
  content: string
  isNearViewport: boolean
  onClick: () => void
  previewText: string
  remainingLineCount: number
  showHtmlPreview: boolean
}) {
  const previewRef = useRef<HTMLButtonElement>(null)
  const [renderedHeight, setRenderedHeight] = useState<number>()
  useLayoutEffect(() => {
    if (!isNearViewport) return
    const preview = previewRef.current
    if (!preview) return
    const updateHeight = () => {
      const height = preview.getBoundingClientRect().height
      setRenderedHeight((current) => current === height ? current : height)
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(preview)
    return () => observer.disconnect()
  }, [isNearViewport])

  const display = call.name === 'read' || call.name === 'write'
    ? readContentDisplay(call.args)
    : { kind: 'text' as const }
  const isRenderable = display.kind === 'csv' || display.kind === 'markdown'
    || display.kind === 'html' || display.kind === 'svg'
  const remainingLabel = isRenderable
    ? 'View source'
    : `Click to view ${remainingLineCount} more ${remainingLineCount === 1 ? 'line' : 'lines'}`
  const showLabel = remainingLineCount > 0 || isRenderable
  const highlightedCode = display.kind === 'code' && canHighlightFile(content)
  const svgPreview = display.kind === 'svg' && content.trim().length > 0
  const htmlPreview = display.kind === 'html' && showHtmlPreview
  const markdownPreview = display.kind === 'markdown'
  const csvPreview = display.kind === 'csv'
  const parsedCsv = useMemo(
    () => csvPreview && isNearViewport ? parseCsvPreview(content) : null,
    [content, csvPreview, isNearViewport],
  )
  const filePath = toolFilePath(call.args)
  const isReadOrWrite = call.name === 'read' || call.name === 'write'
  const startLine = isReadOrWrite ? readStartingLineNumber(call.args) : 1
  const plainContent = isNearViewport ? content : previewText
  const plainPreview = csvPreview
    ? <pre>{content.length > 400 ? `${content.slice(0, 400)}…` : content}</pre>
    : isReadOrWrite
    ? <NumberedPre content={plainContent} startLine={startLine} />
    : <pre>{plainContent}</pre>

  if (!isNearViewport && renderedHeight !== undefined) {
    return (
      <div
        aria-hidden='true'
        className='tool-call-preview-placeholder'
        style={{ height: renderedHeight }}
      />
    )
  }

  return (
    <button className='tool-call-preview' onClick={onClick} ref={previewRef} type='button'>
      {csvPreview
        ? isNearViewport && parsedCsv
          ? <CsvTable preview={parsedCsv} />
          : plainPreview
        : markdownPreview
        ? isNearViewport
          ? (
            <div className='tool-call-markdown-preview'>
              <Markdown renderFrontmatter>{content}</Markdown>
            </div>
          )
          : plainPreview
        : htmlPreview
        ? isNearViewport
          ? (
            <iframe
              className='tool-call-html-preview'
              sandbox=''
              srcDoc={stripScripts(content).replace(
                /^\s*<!doctype[^>]*>|^/i,
                (doctype) => `${doctype}${htmlPreviewPolicy}`,
              )}
              title={`HTML preview of ${filePath ?? 'file'}`}
            />
          )
          : plainPreview
        : svgPreview
        ? isNearViewport
          ? (
            <img
              alt={`SVG preview of ${filePath ?? 'file'}`}
              className='tool-call-svg-preview'
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`}
            />
          )
          : plainPreview
        : highlightedCode && isNearViewport
        ? (
          <Suspense fallback={plainPreview}>
            <LazyCodeHighlighter
              className='tool-call-syntax'
              customStyle={{ background: 'transparent', margin: 0, padding: '9px 10px 4px' }}
              language={display.language}
              PreTag='div'
              showLineNumbers={isReadOrWrite}
              startingLineNumber={isReadOrWrite ? startLine : undefined}
              lineNumberStyle={isReadOrWrite ? lineNumberStyle : undefined}
              wrapLongLines
            >
              {content}
            </LazyCodeHighlighter>
          </Suspense>
        )
        : plainPreview}
      {showLabel && <span>{remainingLabel}</span>}
    </button>
  )
}

/** Renders a bounded CSV table without materializing the complete file in the DOM. */
function CsvTable({ preview }: { preview: CsvPreview }) {
  const [header, ...body] = preview.rows
  if (!header) return <pre className='tool-call-csv-empty'>No CSV rows.</pre>

  return (
    <div className='tool-call-csv-preview'>
      <table aria-label='CSV preview'>
        <thead>
          <tr>
            {header.map((cell, index) => <th key={index} scope='col' title={cell}>{cell}</th>)}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => <td key={columnIndex} title={cell}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.truncated && (
        <p className='tool-call-csv-notice'>
          Preview limited for performance.
        </p>
      )}
    </div>
  )
}

/** Displays a bounded CSV source while preserving the complete value for copying. */
function CsvSourceContent({ content, onCollapse }: { content: string; onCollapse: () => void }) {
  const source = csvSourcePreview(content)
  return (
    <section className='tool-call-content tool-call-csv-source' onClick={onCollapse}>
      {source.truncated && (
        <p className='tool-call-notice'>Source preview limited to 20,000 characters.</p>
      )}
      <pre>{source.text}</pre>
    </section>
  )
}

/** Displays the full result in its appropriate format instead of the preview. */
export function ToolCallContent({
  call,
  content,
  onCollapse,
  renderingCode,
  resultDetails,
  showEditDiff,
}: {
  call: { name: string; args: unknown }
  content: string
  onCollapse: () => void
  renderingCode: boolean
  resultDetails?: unknown
  showEditDiff: boolean
}) {
  if (renderingCode)
    return (
      <section className='tool-call-content tool-call-loading' role='status' onClick={onCollapse}>
        <span aria-hidden='true' className='spinner' />Highlighting file…
      </section>
    )

  const diffString = extractEditDiffString(resultDetails)
  const diffLines = diffString ? parseEditDiff(diffString) : []
  const changes = showEditDiff && call.name === 'edit' ? toolEditChanges(call.args) : []
  if (diffLines.length > 0 || changes.length > 0)
    return <ToolCallEditDiff changes={changes} diffLines={diffLines} onCollapse={onCollapse} />

  const rawContentDisplay = call.name === 'read' || call.name === 'write'
    ? readContentDisplay(call.args)
    : { kind: 'text' as const }
  const display = rawContentDisplay.kind === 'html' || rawContentDisplay.kind === 'svg'
    ? ({ kind: 'code' as const, language: 'markup' })
    : rawContentDisplay.kind === 'markdown'
    ? ({ kind: 'code' as const, language: 'markdown' })
    : rawContentDisplay
  if (rawContentDisplay.kind === 'csv')
    return <CsvSourceContent content={content} onCollapse={onCollapse} />

  const isRenderable = rawContentDisplay.kind === 'markdown'
    || rawContentDisplay.kind === 'html'
    || rawContentDisplay.kind === 'svg'
  const contentClassName = isRenderable
    ? `tool-call-content tool-call-content-scrollable${
      rawContentDisplay.kind === 'markdown' ? ' tool-call-content-markdown' : ''
    }`
    : 'tool-call-content'
  const isReadOrWrite = call.name === 'read' || call.name === 'write'
  const startLine = isReadOrWrite ? readStartingLineNumber(call.args) : 1
  if (display.kind === 'code' && canHighlightFile(content))
    return (
      <section className={contentClassName} onClick={onCollapse}>
        <Suspense
          fallback={isReadOrWrite
            ? <NumberedPre content={content} startLine={startLine} />
            : <pre>{content}</pre>}
        >
          <LazyCodeHighlighter
            className='tool-call-syntax'
            customStyle={{ background: 'transparent', margin: 0, padding: '9px 10px' }}
            language={display.language}
            PreTag='div'
            showLineNumbers={isReadOrWrite}
            startingLineNumber={isReadOrWrite ? startLine : undefined}
            lineNumberStyle={isReadOrWrite ? lineNumberStyle : undefined}
            wrapLongLines
          >
            {content}
          </LazyCodeHighlighter>
        </Suspense>
      </section>
    )
  if (display.kind === 'code')
    return (
      <section className={contentClassName} onClick={onCollapse}>
        <p className='tool-call-notice'>Highlighting disabled beyond 50,000 characters.</p>
        {isReadOrWrite
          ? <NumberedPre content={content} startLine={startLine} />
          : <pre>{content}</pre>}
      </section>
    )
  const plainSectionClass = isRenderable
    ? 'tool-call-content tool-call-content-scrollable'
    : 'tool-call-content'
  return (
    <section className={plainSectionClass} onClick={onCollapse}>
      {isReadOrWrite
        ? <NumberedPre content={content} startLine={startLine} />
        : <pre>{content}</pre>}
    </section>
  )
}

/** Extracts the display-oriented diff string from Pi result details when available. */
function extractEditDiffString(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const d = details as Record<string, unknown>
  return typeof d.diff === 'string' ? d.diff : undefined
}
