// Editing rows in the results grid.
//
// A driver marks a Result as editable by setting Result.edit, when the rows
// come from one table (or collection) and every row can be found again by its
// key. The UI then sends Changes back, which the driver applies in one
// transaction through Driver.apply.

import type { Cell, Changes, Column, EditInfo, EditOp } from './types.ts'

/** What differs between SQL databases when writing edits. */
export type SqlDialect = {
  quote: (ident: string) => string
  /** Placeholder for parameter n, starting at 1. */
  param: (n: number) => string
}

const quoteWith = (open: string, close: string) => (s: string) => open + s.replaceAll(close, close + close) + close

export const dialects = {
  postgres: { quote: quoteWith('"', '"'), param: (n) => `$${n}` },
  mysql: { quote: quoteWith('`', '`'), param: () => '?' },
  sqlite: { quote: quoteWith('"', '"'), param: () => '?' },
  sqlserver: { quote: quoteWith('[', ']'), param: (n) => `@p${n}` },
} satisfies Record<string, SqlDialect>

const sorted = (m: Record<string, unknown> | undefined) => Object.keys(m ?? {}).sort()

/**
 * Turns one op into a statement. object must already be a valid, quoted table
 * reference (callers check it exists); column names are quoted here and values
 * always travel as parameters.
 */
export function buildEdit(d: SqlDialect, object: string, op: EditOp): { sql: string; args: Cell[] } {
  const args: Cell[] = []
  const next = (v: Cell) => {
    args.push(v)
    return d.param(args.length)
  }
  const where = () => {
    const keys = sorted(op.key)
    if (!keys.length) throw new Error('a row to change needs its key')
    const parts = keys.map((k) => {
      const v = op.key?.[k] ?? null
      return v === null ? `${d.quote(k)} is null` : `${d.quote(k)} = ${next(v)}`
    })
    return ` where ${parts.join(' and ')}`
  }
  switch (op.op) {
    case 'update': {
      const keys = sorted(op.values)
      if (!keys.length) throw new Error('an update needs at least one value')
      const sets = keys.map((k) => `${d.quote(k)} = ${next(op.values?.[k] ?? null)}`)
      return { sql: `update ${object} set ${sets.join(', ')}${where()}`, args }
    }
    case 'delete':
      return { sql: `delete from ${object}${where()}`, args }
    case 'insert': {
      const keys = sorted(op.values)
      if (!keys.length) throw new Error('fill in at least one column of the new row')
      const cols = keys.map((k) => d.quote(k))
      const vals = keys.map((k) => next(op.values?.[k] ?? null))
      return { sql: `insert into ${object} (${cols.join(', ')}) values (${vals.join(', ')})`, args }
    }
  }
  throw new Error(`unknown edit ${JSON.stringify((op as EditOp).op)}`)
}

/**
 * Makes sure an update or delete hit exactly one row, so a key that is not
 * unique after all never changes more than the user saw.
 */
export function checkAffected(i: number, op: EditOp, n: number) {
  if (op.op === 'insert' || n === 1) return
  throw new Error(`change ${i + 1} (${op.op}) matched ${n} rows instead of 1, nothing was saved`)
}

export function editSummary(c: Changes): string {
  const count = { update: 0, insert: 0, delete: 0 }
  for (const op of c.ops) count[op.op]++
  const words = { update: 'updated', insert: 'inserted', delete: 'deleted' }
  return (['update', 'insert', 'delete'] as const)
    .filter((k) => count[k] > 0)
    .map((k) => `${words[k]} ${count[k]}`)
    .join(', ')
}

// One identifier: plain, "quoted", `backticked` or [bracketed].
const backticked = '`[^`]+`'
const ident = String.raw`(?:[\w$]+|"[^"]+"|${backticked}|\[[^\]]+\])`

// "select <list> from <table> [alias] [where|order|limit ...]", the shape a
// grid can write back to. Joins, grouping and set operations are ruled out separately.
const simpleSelectRE = new RegExp(
  String.raw`^\s*select\s+(?:top\s*\(?\s*\d+\s*\)?\s+)?([\s\S]+?)\s+from\s+(${ident}(?:\s*\.\s*${ident})*)(?:\s+(?:as\s+)?([\w$]+))?\s*(?:(?:where|order|limit|offset|fetch)\b[\s\S]*)?;?\s*$`,
  'i',
)
const selectItemRE = new RegExp(String.raw`^(?:[\w$]+\s*\.\s*)?(?:\*|[\w$]+|"[^"]+"|${backticked}|\[[^\]]+\])$`)
const notSimpleRE = /\b(join|union|intersect|except|group\s+by|having|distinct|window|over)\b/i

/**
 * The table a plain single-table SELECT reads, as written in the statement.
 * Drivers without per-column table information use it to decide whether a
 * result is editable.
 */
export function singleTableSelect(stmt: string): string | null {
  const m = simpleSelectRE.exec(stmt)
  if (!m || notSimpleRE.test(stmt)) return null
  const alias = (m[3] ?? '').toLowerCase()
  if (['where', 'order', 'limit', 'offset', 'fetch'].includes(alias)) return null
  // The select list may only name columns: *, t.*, col, t.col.
  for (const item of (m[1] ?? '').split(',')) {
    if (!selectItemRE.test(item.trim())) return null
  }
  return (m[2] ?? '').trim()
}

/**
 * EditInfo for a result read from one table, given the table's columns and
 * primary key. Null when a key column is missing from the result, since such
 * rows cannot be found again.
 */
export function editInfoFor(
  object: string,
  database: string,
  result: Column[],
  tableCols: string[],
  pk: string[],
): EditInfo | undefined {
  if (!pk.length) return undefined
  const find = (name: string) => tableCols.find((c) => c.toLowerCase() === name.toLowerCase()) ?? ''
  const seen = new Set<string>()
  const columns = result.map((c) => {
    let col = find(c.name)
    if (col && seen.has(col)) col = '' // the same column twice: only the first copy is editable
    seen.add(col)
    return col
  })
  if (!pk.every((k) => columns.includes(k))) return undefined
  return { object, ...(database ? { database } : {}), key: pk, columns }
}
