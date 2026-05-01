const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'
const ESCAPED_TAG_OPEN = '<{\'|\'}'
const ESCAPED_TAG_CLOSE = '{\'|\'}>'

interface MarkerToken {
  type: 'literal' | 'special' | 'flush-ack'
  value: string
}

type ParserInputChunk
  = | { kind: 'text', text: string }
    | { kind: 'flush' }

interface MarkerParserOptions {
  minLiteralEmitLength?: number
}

interface StreamController<T> {
  stream: ReadableStream<T>
  write: (value: T) => void
  close: () => void
  error: (err: unknown) => void
}

function createPushStream<T>(): StreamController<T> {
  let closed = false
  let controller: ReadableStreamDefaultController<T> | null = null

  const stream = new ReadableStream<T>({
    start(ctrl) {
      controller = ctrl
    },
    cancel() {
      closed = true
    },
  })

  return {
    stream,
    write(value) {
      if (!controller || closed)
        return
      controller.enqueue(value)
    },
    close() {
      if (!controller || closed)
        return
      closed = true
      controller.close()
    },
    error(err) {
      if (!controller || closed)
        return
      closed = true
      controller.error(err)
    },
  }
}

async function readStream<T>(stream: ReadableStream<T>, handler: (value: T) => Promise<void> | void) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      await handler(value as T)
    }
  }
  finally {
    reader.releaseLock()
  }
}

function createLlmMarkerParser(options?: MarkerParserOptions) {
  const minLiteralEmitLength = Math.max(1, options?.minLiteralEmitLength ?? 1)
  const tailLength = Math.max(TAG_OPEN.length - 1, ESCAPED_TAG_OPEN.length - 1)
  let buffer = ''
  let inTag = false

  return {
    async consume(textPart: string, onLiteral: (value: string) => Promise<void> | void, onSpecial: (value: string) => Promise<void> | void) {
      buffer += textPart
      buffer = buffer
        .replaceAll(ESCAPED_TAG_OPEN, TAG_OPEN)
        .replaceAll(ESCAPED_TAG_CLOSE, TAG_CLOSE)

      while (buffer.length > 0) {
        if (!inTag) {
          const openTagIndex = buffer.indexOf(TAG_OPEN)
          if (openTagIndex < 0) {
            if (buffer.length - tailLength >= minLiteralEmitLength) {
              const emit = buffer.slice(0, -tailLength)
              buffer = buffer.slice(-tailLength)
              await onLiteral(emit)
            }
            break
          }

          if (openTagIndex > 0) {
            const emit = buffer.slice(0, openTagIndex)
            buffer = buffer.slice(openTagIndex)
            await onLiteral(emit)
          }
          inTag = true
        }
        else {
          const closeTagIndex = buffer.indexOf(TAG_CLOSE)
          if (closeTagIndex < 0)
            break

          const emit = buffer.slice(0, closeTagIndex + TAG_CLOSE.length)
          buffer = buffer.slice(closeTagIndex + TAG_CLOSE.length)
          await onSpecial(emit)
          inTag = false
        }
      }
    },

    async end(onLiteral: (value: string) => Promise<void> | void) {
      if (!inTag && buffer.length > 0) {
        await onLiteral(buffer)
        buffer = ''
      }
    },

    /**
     * Force-emits any buffered literal text without closing the parser.
     *
     * Use when:
     * - An out-of-band event (e.g. a tool-call event from the upstream LLM
     *   stream) is about to interrupt the visible token order. Without
     *   flushing, the buffer's tail (held back to disambiguate marker
     *   openings) only surfaces after the interrupting event, producing
     *   the "last token cut and shown after the tool call" bug.
     *
     * Expects:
     * - Caller asserts no more text-deltas are coming "right now". If a
     *   tag open is mid-buffer (inTag == true) the flush is skipped to
     *   avoid splitting a marker.
     */
    async flush(onLiteral: (value: string) => Promise<void> | void) {
      if (!inTag && buffer.length > 0) {
        await onLiteral(buffer)
        buffer = ''
      }
    },
  }
}

function createLlmMarkerStream(input: ReadableStream<ParserInputChunk>, options?: MarkerParserOptions) {
  const { stream, write, close, error } = createPushStream<MarkerToken>()
  const parser = createLlmMarkerParser(options)

  const onLiteral = async (literal: string) => {
    if (!literal)
      return
    write({ type: 'literal', value: literal })
  }
  const onSpecial = async (special: string) => {
    write({ type: 'special', value: special })
  }

  void readStream(input, async (chunk) => {
    if (chunk.kind === 'text') {
      await parser.consume(chunk.text, onLiteral, onSpecial)
      return
    }
    // Flush request: emit any buffered literal first, then ack so the
    // public flush() promise can resolve in caller-write order.
    await parser.flush(onLiteral)
    write({ type: 'flush-ack', value: '' })
  })
    .then(async () => {
      await parser.end(onLiteral)
      close()
    })
    .catch((err) => {
      error(err)
    })

  return stream
}

/**
 * A streaming parser for LLM responses that contain special markers (e.g., for tool calls).
 * This composable is designed to be efficient and robust, using a stream-based parser
 * to handle special tags enclosed in `<|...|>`.
 *
 * @example
 * const parser = useLlmmarkerParser({
 *   onLiteral: (text) => console.log('Literal:', text),
 *   onSpecial: (tagContent) => console.log('Special:', tagContent),
 * });
 *
 * await parser.consume('This is some text <|tool_code|> and some more |> text.');
 * await parser.end();
 */
export function useLlmmarkerParser(options: {
  onLiteral?: (literal: string) => void | Promise<void>
  onSpecial?: (special: string) => void | Promise<void>
  /**
   * Called when parsing ends with the full accumulated text.
   * Useful for final processing like categorization or filtering.
   */
  onEnd?: (fullText: string) => void | Promise<void>
  /**
   * The minimum length of text required to emit a literal part.
   * Useful for avoiding emitting literal parts too fast.
   */
  minLiteralEmitLength?: number
}) {
  let fullText = ''
  const { stream, write, close } = createPushStream<ParserInputChunk>()

  const markerStream = createLlmMarkerStream(stream, { minLiteralEmitLength: options.minLiteralEmitLength })

  // Pending flush() promises, resolved in FIFO order as `flush-ack` tokens
  // arrive on the output stream. FIFO is preserved because both inputs
  // (text chunks + flush requests) share one ReadableStream and tokens are
  // written sequentially as the inner parser consumes them.
  const pendingFlushAcks: Array<() => void> = []

  const processing = readStream(markerStream, async (token) => {
    if (token.type === 'literal') {
      await options.onLiteral?.(token.value)
      return
    }
    if (token.type === 'special') {
      await options.onSpecial?.(token.value)
      return
    }
    if (token.type === 'flush-ack') {
      pendingFlushAcks.shift()?.()
    }
  })

  return {
    /**
     * Consumes a chunk of text from the stream.
     * @param textPart The chunk of text to consume.
     */
    async consume(textPart: string) {
      fullText += textPart
      write({ kind: 'text', text: textPart })
    },

    /**
     * Force-emits any buffered literal text immediately, in stream order.
     *
     * Use when:
     * - An out-of-band event (tool call, reasoning event, etc.) is about
     *   to be appended to the UI and you want any buffered literal text
     *   to land *before* it. Without this, up to a handful of trailing
     *   chars stay trapped in the parser's buffer and surface only when
     *   the next text-delta arrives, producing visibly out-of-order text.
     *
     * Returns:
     * - Resolves once every chunk written before this call has been
     *   processed by the inner parser and any pending literal emitted.
     */
    async flush() {
      const ack = new Promise<void>(resolve => pendingFlushAcks.push(resolve))
      write({ kind: 'flush' })
      await ack
    },

    /**
     * Finalizes the parsing process.
     * Any remaining content in the buffer is flushed as a final literal part.
     * This should be called after the stream has ended.
     */
    async end() {
      close()
      await processing
      await options.onEnd?.(fullText)
    },
  }
}
