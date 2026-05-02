/**
 * Per-message timestamp prefix.
 *
 * Replaces the old `<context><module name="system:datetime">...</module></context>`
 * block (which weak local models tended to mirror back into replies and which
 * invalidated KV-cache prefixes on every send).
 *
 * Strategy:
 * - Each user/assistant message is prefixed with `[YYYY-MM-DD HH:MM]` derived
 *   from its persisted `createdAt`. Stored timestamps never change, so the
 *   prefixed history stays byte-stable across turns and accumulates KV-cache
 *   prefix matches.
 * - The full date is included on every message so the model can infer "today"
 *   from the most recent message. There is no separate system-prompt date
 *   anchor, which keeps the system prompt 100% static and permanently
 *   cacheable across turns and across day boundaries.
 *
 * Format choice:
 * - `[YYYY-MM-DD HH:MM]` is ISO-like, structurally compact (~17 chars), and
 *   sits in a region of the training distribution where bracketed datetime
 *   prefixes occur naturally (chat logs, IRC, syslog), which suppresses the
 *   "echo it back as data" tendency of weak local models.
 * - `Date.toString()` (e.g. `Sat Apr 25 2026 18:47:00 GMT+0800 (China Standard
 *   Time)`) is avoided: too long, trailing locale parens carry no useful
 *   signal, and the format clusters in log/debug-output training data which
 *   correlates with verbatim copy-back.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * Formats a timestamp as `[YYYY-MM-DD HH:MM] ` in the user's local timezone.
 *
 * Use when:
 * - Annotating user/assistant messages so the model has a concrete time
 *   anchor on every turn. Historic and current alike use the same shape so
 *   that prefix-cache stays valid when a "current" turn becomes "historic" on
 *   the next send.
 *
 * Returns:
 * - String including a trailing space, e.g. `"[2026-04-25 18:47] "`.
 *
 * Before:
 * - createdAt = 1745570820000  (a Unix ms in Asia/Shanghai)
 *
 * After:
 * - "[2026-04-25 18:47] "
 */
export function formatTimePrefix(createdAt: number): string {
  // Intl en-CA locale uses ISO-style `YYYY-MM-DD, HH:MM`. Strip the comma to
  // produce the bracketed `YYYY-MM-DD HH:MM` form.
  const formatted = DATE_TIME.format(new Date(createdAt)).replace(', ', ' ')
  return `[${formatted}] `
}

const PREFIX_AT_LINE_HEAD_RE = /(^|\n)\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ?/g
const PREFIX_ANCHORED_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ?/

// `PREFIX_TEMPLATE` (length 18) covers the bracketed body up to the closing
// `]`. `PREFIX_MAX_LEN` (19) extends that by one byte so the streaming
// matcher can also consume the optional trailing space in a single regex
// pass. The trailing space is regex-optional, so the partial-match check
// (`couldStillMatchPrefix`) deliberately does not depend on it.
const PREFIX_MAX_LEN = 19
// NOTICE: Template chars are ASCII-only on purpose. `couldStillMatchPrefix`
// compares per-codeunit (`buf[i] === slot`), which would silently break for
// surrogate pairs if anyone ever swapped in a non-ASCII character here.
const PREFIX_TEMPLATE = '[####-##-## ##:##]'

/**
 * Returns true if `buf[start..]` is byte-for-byte compatible with the start
 * of a `[YYYY-MM-DD HH:MM]` prefix. A short buffer is "still on track" iff
 * every byte present so far matches the template at the same position.
 */
function couldStillMatchPrefix(buf: string, start: number): boolean {
  const limit = Math.min(buf.length - start, PREFIX_TEMPLATE.length)
  for (let i = 0; i < limit; i++) {
    const slot = PREFIX_TEMPLATE[i]
    const ch = buf[start + i]
    const ok = slot === '#' ? (ch >= '0' && ch <= '9') : ch === slot
    if (!ok)
      return false
  }
  return true
}

type PrefixDecision
  = | { kind: 'matched', advanceTo: number } // skip past a matched prefix
    | { kind: 'absent' } //                    no prefix at this position
    | { kind: 'pending' } //                   need more bytes to decide

/**
 * Decides what to do with a possible prefix beginning at `input[start]`.
 *
 * Use when:
 * - Walking a chunked stream and you have just landed at a line head and
 *   need to know whether the next bytes are an echoed timestamp.
 *
 * Returns:
 * - `matched` with the index after the prefix when one is present.
 * - `absent` when the bytes at `start` definitively are not a prefix.
 * - `pending` when there are not enough bytes yet; the caller should hold
 *   the tail and try again with the next chunk. `isFinal=true` forces a
 *   verdict (never returns `pending`), used at end-of-stream.
 */
function decidePrefixAt(input: string, start: number, isFinal: boolean): PrefixDecision {
  const haveEnough = input.length - start >= PREFIX_MAX_LEN
  if (haveEnough || isFinal) {
    const match = input.slice(start, start + PREFIX_MAX_LEN).match(PREFIX_ANCHORED_RE)
    return match ? { kind: 'matched', advanceTo: start + match[0].length } : { kind: 'absent' }
  }
  return couldStillMatchPrefix(input, start) ? { kind: 'pending' } : { kind: 'absent' }
}

/**
 * Removes echoed `[YYYY-MM-DD HH:MM] ` prefixes that sit at a line head
 * (start of input or immediately after `\n`).
 *
 * Use when:
 * - You have a complete string (e.g. an assembled assistant message) and
 *   want every line-head occurrence of the per-turn datetime injection
 *   removed. For chunked streaming use `createTimestampPrefixStripper`.
 *
 * Returns:
 * - The input with each line-head prefix removed and the boundary `\n`
 *   preserved. No-op when no prefix is present.
 */
export function stripTimestampPrefixesAtLineHeads(text: string): string {
  return text.replace(PREFIX_AT_LINE_HEAD_RE, '$1')
}

/**
 * Stateful stripper for chunked input.
 *
 * Use when:
 * - Forwarding streamed assistant text to surfaces that should never see the
 *   timestamp echo (chat transcript, TTS). One stripper per stream; do not
 *   share across streams.
 *
 * Expects:
 * - Chunks delivered in order. A prefix may straddle chunks at any byte.
 * - `pending` only ever holds bytes positioned at a line head; the streaming
 *   logic never buffers mid-line. Subsequent boundary detection relies on
 *   that invariant.
 *
 * Returns:
 * - `consume(chunk)` yields the chunk with line-head prefixes removed. May
 *   hold a tail when a chunk ends inside a candidate prefix.
 * - `end()` flushes any tail held when the stream finishes mid-candidate.
 *   The caller must route the returned bytes through the same downstream
 *   pipeline as `consume` output, otherwise the tail is silently dropped.
 */
export function createTimestampPrefixStripper() {
  let pending = ''
  let lastModelChar: string | null = null

  function stripChunk(input: string, isFinal: boolean): string {
    let out = ''
    let i = 0
    let atLineHead = lastModelChar === null || lastModelChar === '\n'

    while (i < input.length) {
      if (atLineHead) {
        const decision = decidePrefixAt(input, i, isFinal)
        if (decision.kind === 'pending') {
          pending = input.slice(i)
          return out
        }
        if (decision.kind === 'matched')
          i = decision.advanceTo
        atLineHead = false
        continue
      }

      const nl = input.indexOf('\n', i)
      if (nl < 0) {
        out += input.slice(i)
        return out
      }
      out += input.slice(i, nl + 1)
      i = nl + 1
      atLineHead = true
    }

    return out
  }

  return {
    consume(chunk: string): string {
      if (chunk === '')
        return ''

      const merged = pending + chunk
      pending = ''
      const out = stripChunk(merged, false)

      // `pending` only ever forms at a line head, so the byte right before
      // it is also the most recent byte we have emitted. Remembering it lets
      // the next chunk decide its own line-head state without re-scanning.
      const pendingStart = merged.length - pending.length
      if (pendingStart > 0)
        lastModelChar = merged[pendingStart - 1]

      return out
    },
    end(): string {
      if (pending === '')
        return ''
      const out = stripChunk(pending, true)
      pending = ''
      return out
    },
  }
}
