// Grid editing rules, kept apart from the components so they stay small.
//
// A result is editable when the driver says which table and key it comes from
// (r.edit) and the connection is not read-only. Changes wait in Pending until
// Submit sends them in one batch.

import type { Cell, Conn, Result } from './api'
import type { Change, Pending } from './state'

export type RowRef = { row: number } | { ins: number }

export const isIns = (ref: RowRef): ref is { ins: number } => 'ins' in ref

export const emptyPending = (): Pending => ({ upd: {}, del: {}, ins: [] })

export function canEdit(
  r: Result | undefined,
  conn: Conn | undefined,
): r is Result & { edit: NonNullable<Result['edit']> } {
  return !!(r?.edit && conn && !conn.readOnly)
}

export function editableCol(r: Result, conn: Conn, ci: number): boolean {
  const name = r.edit?.columns[ci]
  if (!name) return false
  return !(conn.kind === 'mongo' && name === '_id') // MongoDB never changes an _id
}

export function cellText(v: Cell | undefined): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}

export function prettyJSON(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

export function cellChange(p: Pending | undefined, ref: RowRef, ci: number): Change | undefined {
  if (!p) return undefined
  const row = isIns(ref) ? p.ins[ref.ins] : p.upd[ref.row]
  return row?.[ci]
}

type Original = { text: string; isNull: boolean; kind: 'none' | 'null' | 'string' | 'json' | 'text' }

/** The cell's value as the editor shows it, plus its JSON type for MongoDB (strings are edited without quotes). */
export function originalFor(r: Result, conn: Conn, ref: RowRef, ci: number): Original {
  if (isIns(ref)) return { text: '', isNull: true, kind: 'none' }
  const doc = conn.kind === 'mongo' ? r.docs?.[ref.row] : undefined
  if (doc !== undefined) {
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(doc)
    } catch {
      // keep empty
    }
    const v = parsed[r.columns[ci]?.name ?? '']
    if (v === undefined) return { text: '', isNull: true, kind: 'none' }
    if (v === null) return { text: '', isNull: true, kind: 'null' }
    if (typeof v === 'string') return { text: v, isNull: false, kind: 'string' }
    return { text: JSON.stringify(v), isNull: false, kind: 'json' }
  }
  const v = r.rows[ref.row]?.[ci]
  const isNull = v === null || v === undefined
  return { text: isNull ? '' : cellText(v), isNull, kind: 'text' }
}

/** What was typed, as the server expects it: text for SQL, relaxed Extended JSON for MongoDB. */
function toWire(conn: Conn, text: string, orig: Original): Cell {
  if (conn.kind !== 'mongo') return text
  if (orig.kind === 'string') return JSON.stringify(text)
  try {
    JSON.parse(text)
    return text
  } catch {
    if (orig.kind === 'json') throw new Error('Not valid JSON. Quote text, e.g. "abc".')
    return JSON.stringify(text) // a new field: plain text means a string
  }
}

/** Returns the pending changes with one cell set (or set back to its original value). */
export function withChange(
  p: Pending,
  r: Result,
  conn: Conn,
  ref: RowRef,
  ci: number,
  text: string,
  isNull: boolean,
): Pending {
  const orig = originalFor(r, conn, ref, ci)
  const next: Pending = { upd: { ...p.upd }, del: { ...p.del }, ins: [...p.ins] }
  const change: Change = isNull
    ? { value: null, text: 'NULL', wire: null }
    : { value: text, text, wire: toWire(conn, text, orig) }
  if (isIns(ref)) {
    next.ins[ref.ins] = { ...next.ins[ref.ins], [ci]: change }
    return next
  }
  const row = { ...next.upd[ref.row] }
  if (isNull === orig.isNull && (isNull || text === orig.text)) delete row[ci]
  else row[ci] = change
  if (Object.keys(row).length) next.upd[ref.row] = row
  else delete next.upd[ref.row]
  return next
}

function rowKey(r: Result, conn: Conn, ri: number): Record<string, Cell> {
  const key: Record<string, Cell> = {}
  for (const k of r.edit?.key ?? []) {
    const ci = r.edit?.columns.indexOf(k) ?? -1
    if (conn.kind === 'mongo') {
      const doc = JSON.parse(r.docs?.[ri] ?? '{}')
      key[k] = JSON.stringify(doc[r.columns[ci]?.name ?? ''])
    } else {
      key[k] = r.rows[ri]?.[ci] ?? null
    }
  }
  return key
}

function values(r: Result, changes: Record<number, Change> | undefined): Record<string, Cell> {
  const out: Record<string, Cell> = {}
  for (const [ci, c] of Object.entries(changes ?? {})) {
    const col = r.edit?.columns[Number(ci)]
    if (col) out[col] = c.wire
  }
  return out
}

export type EditOp = { op: 'update' | 'delete' | 'insert'; key?: Record<string, Cell>; values?: Record<string, Cell> }

export function buildOps(r: Result, conn: Conn, p: Pending): EditOp[] {
  const ops: EditOp[] = []
  for (const [ri, changes] of Object.entries(p.upd)) {
    if (!p.del[Number(ri)]) ops.push({ op: 'update', key: rowKey(r, conn, Number(ri)), values: values(r, changes) })
  }
  for (const ri of Object.keys(p.del)) ops.push({ op: 'delete', key: rowKey(r, conn, Number(ri)) })
  for (const row of p.ins) {
    const v = values(r, row)
    if (Object.keys(v).length) ops.push({ op: 'insert', values: v })
  }
  return ops
}

export function asCSV(r: Result): string {
  const esc = (v: Cell | undefined) => {
    const s = cellText(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [r.columns.map((c) => esc(c.name)).join(','), ...r.rows.map((row) => row.map(esc).join(','))].join('\n')
}

export function asJSON(r: Result): string {
  if (r.docs?.length) return `[\n${r.docs.map((d) => `  ${d}`).join(',\n')}\n]`
  return JSON.stringify(
    r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]]))),
    null,
    2,
  )
}

export const numericTypes = new Set([
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'numeric',
  'oid',
  'money',
  'int',
  'integer',
  'tinyint',
  'smallint',
  'mediumint',
  'bigint',
  'decimal',
  'float',
  'double',
  'real',
  'unsigned int',
  'unsigned bigint',
  'unsigned tinyint',
  'unsigned smallint',
  'unsigned mediumint',
  'smallmoney',
])

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
