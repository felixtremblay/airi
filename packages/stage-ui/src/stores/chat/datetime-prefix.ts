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
const PREFIX_MAX_LEN = 19
const PREFIX_TEMPLATE = '[####-##-## ##:##]'

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

/**
 * Looks at `input[start..]` and reports what to do with a possible prefix:
 * - a number `>= start` to skip past a matched prefix (or `=== start` if no
 *   prefix was present)
 * - `null` if there are not yet enough bytes to decide; the caller should
 *   buffer the tail and try again with the next chunk
 */
function consumePrefixAt(input: string, start: number, isFinal: boolean): number | null {
  const haveEnough = input.length - start >= PREFIX_MAX_LEN
  if (haveEnough || isFinal) {
    const match = input.slice(start, start + PREFIX_MAX_LEN).match(PREFIX_ANCHORED_RE)
    return match ? start + match[0].length : start
  }
  return couldStillMatchPrefix(input, start) ? null : start
}

/**
 * Removes echoed `[YYYY-MM-DD HH:MM] ` prefixes that sit at a line head
 * (start of input or immediately after a `\n`). Used on assembled text.
 */
export function stripLeadingTimestampPrefix(text: string): string {
  return text.replace(PREFIX_AT_LINE_HEAD_RE, '$1')
}

/**
 * Streaming version of `stripLeadingTimestampPrefix` for chunked input.
 * Holds back a tail when a chunk ends inside a candidate prefix; flush via
 * `end()` if the stream finishes mid-candidate.
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
        const after = consumePrefixAt(input, i, isFinal)
        if (after === null) {
          pending = input.slice(i)
          return out
        }
        i = after
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

      // Track the char immediately before whatever ends up in `pending` so
      // the next chunk knows whether its first byte sits at a line head.
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
