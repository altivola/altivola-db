// The shapes every driver shares, so the web UI and the MCP server treat
// every database the same way.

export const kinds = ['postgres', 'mongo', 'mysql', 'sqlite', 'sqlserver', 'redis', 'd1'] as const
export type Kind = (typeof kinds)[number]

/** A grid cell. SQL drivers send text (like psql prints it), MongoDB sends JSON-friendly values. */
export type Cell = string | number | boolean | null

export type Column = { name: string; type?: string }

/** Tells the UI how to write a result back (see edit.ts). */
export type EditInfo = {
  /** What apply() accepts, usually the same string describe() takes. */
  object: string
  database?: string
  /** The table columns that identify a row, e.g. the primary key. Each one appears in columns. */
  key: string[]
  /** The table column behind each result column, or '' when it cannot be written (an expression). */
  columns: string[]
}

/** One statement's output, shaped as a table. */
export type Result = {
  title?: string
  statement?: string
  columns: Column[]
  rows: Cell[][]
  /** Each MongoDB document as relaxed Extended JSON, for the JSON view. */
  docs?: string[]
  affected: number
  truncated: boolean
  ms: number
  message?: string
  error?: string
  /** Set when the rows can be edited in the grid. */
  edit?: EditInfo
}

/** One entry in the object tree: a schema or database, and its tables or collections. */
export type TreeNode = {
  name: string
  kind: string
  /** What describe() accepts, e.g. "public.users". */
  object?: string
  database?: string
  children?: TreeNode[]
}

export type EditOp = {
  op: 'update' | 'delete' | 'insert'
  /** The row's key values. */
  key?: Record<string, Cell>
  /** New column values. SQL drivers get text (or null) and let the database cast it; MongoDB gets relaxed Extended JSON. */
  values?: Record<string, Cell>
}

/** One batch of grid edits for one object. */
export type Changes = { object: string; ops: EditOp[] }

/**
 * Implemented once per database kind.
 *
 * query() runs every statement in order and stops at the first failing one,
 * whose Result carries the error. A thrown error is kept for failures that
 * are not tied to a statement, such as a lost connection.
 */
export interface Driver {
  tree(): Promise<TreeNode[]>
  describe(database: string, object: string): Promise<Result[]>
  query(database: string, q: string, limit: number, signal?: AbortSignal): Promise<Result[]>
  explain(database: string, q: string, analyze: boolean): Promise<Result[]>
  /** Writes grid edits. Only drivers whose results can be edited have it. */
  apply?(database: string, changes: Changes): Promise<Result>
  close(): Promise<void>
}

export type Conn = {
  id: string
  name: string
  kind: Kind
  url: string
  readOnly: boolean
}

export type HistoryEntry = {
  connId: string
  database?: string
  query: string
  source: 'ui' | 'mcp'
  at: string
  ms: number
  error?: string
}

/** A result with nothing in it yet. */
export function emptyResult(extra: Partial<Result> = {}): Result {
  return { columns: [], rows: [], affected: 0, truncated: false, ms: 0, ...extra }
}

export class ReadOnlyError extends Error {
  constructor() {
    super('this connection is read-only')
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof AggregateError && e.errors.length) return e.errors.map(errorMessage).join('; ')
  if (e instanceof Error) return e.message || e.name
  return String(e)
}
