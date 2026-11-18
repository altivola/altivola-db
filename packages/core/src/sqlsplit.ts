// Splitting scripts into statements, and other small SQL text helpers.

export type SplitOptions = {
  /** Backtick identifiers, backslash escapes in strings, # comments. */
  mysql?: boolean
  /** T-SQL [identifiers]. */
  brackets?: boolean
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c)
const isIdent = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

/**
 * Splits a script on top-level semicolons. Semicolons inside quotes, quoted
 * identifiers, dollar-quoted bodies and comments are skipped. Statements that
 * hold only comments or whitespace are dropped.
 */
export function splitSQL(script: string, o: SplitOptions = {}): string[] {
  const s = [...script]
  const out: string[] = []
  let start = 0
  let hasCode = false

  const flush = (end: number) => {
    if (hasCode) out.push(s.slice(start, end).join('').trim())
    start = end + 1
    hasCode = false
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ((c === '-' && s[i + 1] === '-') || (o.mysql && c === '#')) {
      while (i < s.length && s[i] !== '\n') i++
    } else if (c === '/' && s[i + 1] === '*') {
      i = skipBlockComment(s, i)
    } else if (c === "'") {
      const escapes = !!o.mysql || (i > 0 && (s[i - 1] === 'E' || s[i - 1] === 'e') && !isIdent(s[i - 2]))
      i = skipQuoted(s, i, "'", escapes)
      hasCode = true
    } else if (c === '"') {
      i = skipQuoted(s, i, '"', !!o.mysql)
      hasCode = true
    } else if (o.mysql && c === '`') {
      i = skipQuoted(s, i, '`', false)
      hasCode = true
    } else if (o.brackets && c === '[') {
      i = skipQuoted(s, i, ']', false)
      hasCode = true
    } else if (!o.mysql && !o.brackets && c === '$') {
      const tag = dollarTag(s, i)
      if (tag) i = skipDollarBody(s, i, tag)
      hasCode = true
    } else if (c === ';') {
      flush(i)
    } else if (!isSpace(c)) {
      hasCode = true
    }
  }
  if (start < s.length) flush(s.length)
  return out
}

/** Returns the index of the closing '/'. Postgres block comments nest. */
function skipBlockComment(s: string[], i: number): number {
  let depth = 0
  for (; i < s.length; i++) {
    if (s[i] === '/' && s[i + 1] === '*') {
      depth++
      i++
    } else if (s[i] === '*' && s[i + 1] === '/') {
      depth--
      i++
      if (depth === 0) return i
    }
  }
  return s.length
}

/** Returns the index of the closing quote. A doubled quote is an escaped quote; with backslash escapes so is \'. */
function skipQuoted(s: string[], i: number, q: string, backslash: boolean): number {
  for (i++; i < s.length; i++) {
    if (backslash && s[i] === '\\') i++
    else if (s[i] === q && s[i + 1] === q) i++
    else if (s[i] === q) return i
  }
  return s.length
}

/** Reads a $tag$ opener at i. $1 style parameters are not openers. */
function dollarTag(s: string[], i: number): string | null {
  let j = i + 1
  while (j < s.length && isIdent(s[j])) j++
  if (j >= s.length || s[j] !== '$') return null
  const tag = s.slice(i, j + 1).join('')
  if (tag.length > 2 && /\d/.test(tag[1] ?? '')) return null
  return tag
}

function skipDollarBody(s: string[], i: number, tag: string): number {
  const n = [...tag].length
  for (let j = i + n; j + n <= s.length; j++) {
    if (s.slice(j, j + n).join('') === tag) return j + n - 1
  }
  return s.length
}

/** The first word of a statement in lower case, after leading comments and opening parentheses. */
export function firstKeyword(stmt: string): string {
  const s = [...stmt]
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (isSpace(c) || c === '(') continue
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      i = skipBlockComment(s, i)
      continue
    }
    let j = i
    while (j < s.length && isIdent(s[j])) j++
    return s.slice(i, j).join('').toLowerCase()
  }
  return ''
}

/** Splits a T-SQL script on GO lines (as SSMS does) and on semicolons. */
export function splitTSQL(script: string): string[] {
  return script.split(/^[ \t]*go[ \t]*$/im).flatMap((batch) => splitSQL(batch, { brackets: true }))
}

/**
 * Splits a possibly quoted, dotted name such as `shop`.`users`,
 * [dbo].[Orders] or main."my table" into its parts.
 */
export function splitQualified(name: string): string[] {
  const r = [...name.trim()]
  const parts: string[] = []
  const closers: Record<string, string> = { '"': '"', '`': '`', '[': ']' }
  let i = 0
  while (i < r.length) {
    while (r[i] === ' ' || r[i] === '\t') i++
    let part = ''
    const close = closers[r[i] ?? '']
    if (close) {
      i++
      for (;;) {
        if (i >= r.length) throw new Error(`unterminated quote in ${JSON.stringify(name)}`)
        if (r[i] === close) {
          if (r[i + 1] === close) {
            part += close
            i += 2
            continue
          }
          i++
          break
        }
        part += r[i]
        i++
      }
    } else {
      while (i < r.length && r[i] !== '.' && r[i] !== ' ') part += r[i++]
    }
    while (r[i] === ' ') i++
    if (!part) throw new Error(`bad name ${JSON.stringify(name)}`)
    parts.push(part)
    if (i < r.length) {
      if (r[i] !== '.') throw new Error(`bad name ${JSON.stringify(name)}`)
      i++
      if (i >= r.length) throw new Error(`bad name ${JSON.stringify(name)}`)
    }
  }
  if (!parts.length) throw new Error('name a table')
  return parts
}
