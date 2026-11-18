// Shared types for copying, dumping and importing databases.

export const copyModes = ['all', 'schema', 'data'] as const
/** all: schema and data, replacing what the target has. schema: no rows. data: rows only, into tables that exist. */
export type CopyMode = (typeof copyModes)[number]

export type CopyOptions = {
  mode: CopyMode
  /** Limits a Postgres copy or dump to these schemas; empty means all. */
  schemas?: string[]
}

/** Warnings are statements the target refused, e.g. an extension that only exists on the source server. */
export type CopyReport = { warnings: string[] }

/** Receives progress lines. */
export type Log = (line: string) => void
