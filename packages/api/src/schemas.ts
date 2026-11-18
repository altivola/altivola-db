import { copyModes, kinds } from '@app/core'
import { z } from 'zod'

export const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const conn = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(kinds),
  url: z.string(),
  readOnly: z.boolean(),
})

export const connInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  url: z.string(),
  readOnly: z.boolean().default(false),
})

export const result = z.object({
  title: z.string().optional(),
  statement: z.string().optional(),
  columns: z.array(z.object({ name: z.string(), type: z.string().optional() })),
  rows: z.array(z.array(cell)),
  docs: z.array(z.string()).optional(),
  affected: z.number(),
  truncated: z.boolean(),
  ms: z.number(),
  message: z.string().optional(),
  error: z.string().optional(),
  edit: z
    .object({
      object: z.string(),
      database: z.string().optional(),
      key: z.array(z.string()),
      columns: z.array(z.string()),
    })
    .optional(),
})

export const results = z.object({ results: z.array(result) })

type Node = { name: string; kind: string; object?: string; database?: string; children?: Node[] }
export const treeNode: z.ZodType<Node> = z.lazy(() =>
  z.object({
    name: z.string(),
    kind: z.string(),
    object: z.string().optional(),
    database: z.string().optional(),
    children: z.array(treeNode).optional(),
  }),
)

export const editOp = z.object({
  op: z.enum(['update', 'delete', 'insert']),
  key: z.record(z.string(), cell).optional(),
  values: z.record(z.string(), cell).optional(),
})

export const historyEntry = z.object({
  connId: z.string(),
  database: z.string().optional(),
  query: z.string(),
  source: z.enum(['ui', 'mcp']),
  at: z.string(),
  ms: z.number(),
  error: z.string().optional(),
})

export const mode = z.enum(copyModes).default('all')

export const job = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  mode: z.string(),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  error: z.string().optional(),
  warnings: z.array(z.string()),
  log: z.array(z.string()),
  dropped: z.number(),
  started: z.string(),
  finished: z.string().optional(),
})

export const connId = z.object({ id: z.string() })
