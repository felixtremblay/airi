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
 * Formats a timestamp as `[YYYY-MM-DD HH:MM] ` in the user's local timezone,
 * including the trailing space, e.g. `"[2026-04-25 18:47] "`.
 */
export function formatTimePrefix(createdAt: number): string {
  const formatted = DATE_TIME.format(new Date(createdAt)).replace(', ', ' ')
  return `[${formatted}] `
}

const TIMESTAMP_PREFIX_RE = /(^|\n)\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ?/g
const TIMESTAMP_BODY_LEN = 19
const TIMESTAMP_BODY_TEMPLATE = '[####-##-## ##:##]'

function bodyCouldMatchAt(buf: string, start: number): boolean {
  const limit = Math.min(buf.length - start, TIMESTAMP_BODY_TEMPLATE.length)
  for (let i = 0; i < limit; i++) {
    const slot = TIMESTAMP_BODY_TEMPLATE[i]
    const ch = buf[start + i]
    const ok = slot === '#' ? (ch >= '0' && ch <= '9') : ch === slot
    if (!ok)
      return false
  }
  return true
}

/**
 * Removes echoed `[YYYY-MM-DD HH:MM] ` prefixes that appear at the start of
 * the input or immediately after a newline. Used on assembled text.
 */
export function stripLeadingTimestampPrefix(text: string): string {
  return text.replace(TIMESTAMP_PREFIX_RE, '$1')
}

/**
 * Streaming version of `stripLeadingTimestampPrefix` for chunked input.
 * Holds back a tail when a chunk ends inside a candidate prefix; flush via
 * `end()` if the stream finishes mid-candidate.
 */
export function createTimestampPrefixStripper() {
  let pending = ''
  let lastModelChar: string | null = null

  const BODY_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ?/

  function process(input: string, isFinal: boolean): string {
    let out = ''
    let i = 0

    while (i < input.length) {
      const prev = i > 0 ? input[i - 1] : lastModelChar
      const atBoundary = prev === null || prev === '\n'

      if (!atBoundary) {
        out += input[i++]
        continue
      }

      const remaining = input.length - i
      if (remaining >= TIMESTAMP_BODY_LEN || isFinal) {
        const match = input.slice(i, i + TIMESTAMP_BODY_LEN).match(BODY_RE)
        if (match)
          i += match[0].length
        else
          out += input[i++]
        continue
      }

      if (bodyCouldMatchAt(input, i)) {
        pending = input.slice(i)
        return out
      }
      out += input[i++]
    }

    return out
  }

  return {
    consume(chunk: string): string {
      if (chunk === '')
        return ''

      const merged = pending + chunk
      pending = ''
      const out = process(merged, false)

      const consumedEnd = merged.length - pending.length
      if (consumedEnd > 0)
        lastModelChar = merged[consumedEnd - 1]

      return out
    },
    end(): string {
      if (pending === '')
        return ''
      const out = process(pending, true)
      pending = ''
      return out
    },
  }
}
