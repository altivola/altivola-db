import type { Router } from '@app/api'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { InferRouterOutputs, RouterClient } from '@orpc/server'

/** The per-run token the server put in the page. Every API call sends it. */
export const token = document.querySelector<HTMLMetaElement>('meta[name="altivola-db-token"]')?.content ?? ''
export const tokenHeader = 'X-Altivola-Db-Token'

const link = new RPCLink({ url: `${window.location.origin}/rpc`, headers: { [tokenHeader]: token } })

export const api: RouterClient<Router> = createORPCClient(link)

type Out = InferRouterOutputs<Router>
export type Conn = Out['connections']['list'][number]
export type Result = Out['connections']['query']['results'][number]
export type TreeNode = Out['connections']['tree'][number]
export type Job = Out['transfer']['job']
export type HistoryEntry = Out['history'][number]
export type Cell = Result['rows'][number][number]

/** A plain link, so the browser streams the dump to disk itself. */
export function dumpURL(id: string, params: Record<string, string>) {
  return `/files/dump/${encodeURIComponent(id)}?${new URLSearchParams({ ...params, token })}`
}

export async function uploadImport(id: string, file: File, params: Record<string, string>): Promise<Job> {
  const res = await fetch(
    `/files/import/${encodeURIComponent(id)}?${new URLSearchParams({ ...params, file: file.name })}`,
    {
      method: 'POST',
      headers: { [tokenHeader]: token, 'Content-Type': 'application/octet-stream' },
      body: file,
    },
  )
  const data = await res.json().catch(() => ({ error: res.statusText }))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

export function message(e: unknown): string {
  if (e instanceof Error) return e.name === 'AbortError' ? 'Cancelled' : e.message
  return String(e)
}
