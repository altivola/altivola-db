// App state: connections, object trees, query tabs and their results.
//
// Each query tab is its own console: a connection, a database (MongoDB and
// Redis), the editor text and the last results. Text and connection survive
// reloads; results stay in memory.

import { toast } from 'sonner'
import { create } from 'zustand'
import { api, type Cell, type Conn, message, type Result, type TreeNode } from './api'
import { storage } from './storage'

/** Grid edits waiting for Submit, per result. Keys of upd/del are row indexes, of the inner maps column indexes. */
export type Change = { value: Cell; text: string; wire: Cell }
export type Pending = {
  upd: Record<number, Record<number, Change>>
  del: Record<number, true>
  ins: Record<number, Change>[]
}

export type QTab = {
  id: string
  connId: string
  db: string
  text: string
  used?: number
  results: Result[]
  rtab: number
  totalMs?: number
  lastQuery?: string
  running?: boolean
  pending: Record<number, Pending>
}

type TreeState = { loading?: boolean; nodes?: TreeNode[]; error?: string }

type SavedTab = Pick<QTab, 'id' | 'connId' | 'db' | 'text' | 'used'>

type State = {
  conns: Conn[]
  loaded: boolean
  loadError?: string
  trees: Record<string, TreeState>
  expanded: string[]
  collapsed: string[]
  tabs: QTab[]
  active: string | null
  activeObject: string | null
  filter: string
  limit: number
  view: 'grid' | 'json'
}

export const useApp = create<State>(() => ({
  conns: [],
  loaded: false,
  trees: {},
  expanded: storage.get<string[]>('expanded', []),
  collapsed: storage.get<string[]>('collapsed', []),
  tabs: storage.get<SavedTab[]>('qtabs', []).map((t) => ({ ...t, results: [], rtab: 0, pending: {} })),
  active: storage.get<string | null>('qtab', null),
  activeObject: null,
  filter: '',
  limit: storage.get('limit', 500),
  view: 'grid',
}))

const set = useApp.setState
const get = useApp.getState

function saveTabs() {
  const { tabs, active } = get()
  storage.set(
    'qtabs',
    tabs.map(({ id, connId, db, text, used }) => ({ id, connId, db, text, used })),
  )
  storage.set('qtab', active)
}

export const tabId = () => Math.random().toString(36).slice(2, 10)

export function activeTab(s: State = get()): QTab | undefined {
  return s.tabs.find((t) => t.id === s.active)
}

export function activeConn(s: State = get()): Conn | undefined {
  const t = activeTab(s)
  return t && s.conns.find((c) => c.id === t.connId)
}

/** MongoDB and Redis pick their database per tab; SQL names it in the query. */
export const hasDbSelect = (c: Conn | undefined) => c?.kind === 'mongo' || c?.kind === 'redis'

export function updateTab(id: string, patch: Partial<QTab> | ((t: QTab) => Partial<QTab>)) {
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)),
  }))
  if (typeof patch === 'function' || 'text' in patch || 'db' in patch) saveTabs()
}

export async function loadConnections() {
  try {
    const conns = await api.connections.list()
    set((s) => {
      // Tabs of deleted connections go away.
      const tabs = s.tabs.filter((t) => conns.some((c) => c.id === t.connId))
      const active = tabs.some((t) => t.id === s.active) ? s.active : (tabs[tabs.length - 1]?.id ?? null)
      return { conns, tabs, active, loaded: true, loadError: undefined }
    })
    saveTabs()
    const c = activeConn()
    if (c && !get().trees[c.id]) void loadTree(c)
  } catch (e) {
    set({ loaded: true, loadError: message(e) })
  }
}

export async function loadTree(conn: Conn) {
  set((s) => ({ trees: { ...s.trees, [conn.id]: { loading: true } } }))
  let next: TreeState
  try {
    next = { nodes: await api.connections.tree({ id: conn.id }) }
  } catch (e) {
    next = { error: message(e) }
  }
  set((s) => ({ trees: { ...s.trees, [conn.id]: next } }))
}

export function toggleExpanded(key: string, open?: boolean) {
  set((s) => {
    const has = s.expanded.includes(key)
    const want = open ?? !has
    if (want === has) return {}
    const expanded = want ? [...s.expanded, key] : s.expanded.filter((k) => k !== key)
    storage.set('expanded', expanded)
    return { expanded }
  })
}

export function toggleFolder(key: string) {
  set((s) => {
    const collapsed = s.collapsed.includes(key) ? s.collapsed.filter((k) => k !== key) : [...s.collapsed, key]
    storage.set('collapsed', collapsed)
    return { collapsed }
  })
}

export function activateTab(id: string) {
  const tab = get().tabs.find((t) => t.id === id)
  if (!tab) return
  set((s) => ({ active: id, tabs: s.tabs.map((t) => (t.id === id ? { ...t, used: Date.now() } : t)) }))
  saveTabs()
  const c = activeConn()
  if (c && !get().trees[c.id]) void loadTree(c)
}

export function newTab(conn: Conn, text = '') {
  const cur = activeTab()
  const tab: QTab = {
    id: tabId(),
    connId: conn.id,
    db: cur && cur.connId === conn.id ? cur.db : '',
    text,
    results: [],
    rtab: 0,
    pending: {},
    used: Date.now(),
  }
  set((s) => ({ tabs: [...s.tabs, tab], active: tab.id }))
  saveTabs()
  return tab
}

export function closeTab(id: string) {
  set((s) => {
    const i = s.tabs.findIndex((t) => t.id === id)
    if (i < 0) return {}
    const tabs = s.tabs.filter((t) => t.id !== id)
    const active = s.active === id ? (tabs[i]?.id ?? tabs[i - 1]?.id ?? null) : s.active
    return { tabs, active }
  })
  saveTabs()
}

/** Shows a query tab of conn, opening one when it has none, and expands it in the tree. */
export function selectConnection(conn: Conn, { expand = true } = {}) {
  const cur = activeTab()
  if (!cur || cur.connId !== conn.id) {
    const mine = get()
      .tabs.filter((t) => t.connId === conn.id)
      .sort((a, b) => (b.used ?? 0) - (a.used ?? 0))[0]
    if (mine) activateTab(mine.id)
    else newTab(conn)
  }
  const key = `c:${conn.id}`
  if (expand) toggleExpanded(key, true)
  if (get().expanded.includes(key) && !get().trees[conn.id]) void loadTree(conn)
}

export function setDatabase(name: string) {
  const t = activeTab()
  if (t) updateTab(t.id, { db: name })
}

export function setLimit(limit: number) {
  storage.set('limit', limit)
  set({ limit })
}

export function pendingCount(p: Pending | undefined): number {
  if (!p) return 0
  const upd = Object.keys(p.upd).filter((k) => !p.del[Number(k)]).length
  return upd + Object.keys(p.del).length + p.ins.length
}

/** Shows results in a tab, opening the first failed statement or the last one. */
export function showResults(tabId: string, results: Result[], totalMs?: number) {
  const firstError = results.findIndex((r) => r.error)
  updateTab(tabId, {
    results,
    rtab: firstError >= 0 ? firstError : Math.max(results.length - 1, 0),
    totalMs,
    pending: {},
  })
}

const running = new Map<string, AbortController>()

export function cancelRun(tabId: string) {
  running.get(tabId)?.abort()
}

/** Runs query in a tab. explain asks for the plan instead. */
export async function runQuery(
  tab: QTab,
  query: string,
  { explain = false, analyze = false, keepPending = false } = {},
) {
  const conn = get().conns.find((c) => c.id === tab.connId)
  if (!conn || running.has(tab.id)) return
  if (!query.trim()) {
    toast('Nothing to run')
    return
  }
  const dirty = Object.values(tab.pending).some((p) => pendingCount(p) > 0)
  if (dirty && !keepPending && !confirm('Discard the unsaved changes in the results?')) return
  const ctrl = new AbortController()
  running.set(tab.id, ctrl)
  updateTab(tab.id, { running: true })
  const start = performance.now()
  let results: Result[]
  const database = hasDbSelect(conn) ? tab.db : ''
  try {
    if (explain) {
      results = (await api.connections.explain({ id: conn.id, query, database, analyze }, { signal: ctrl.signal }))
        .results
    } else {
      results = (
        await api.connections.query({ id: conn.id, query, database, limit: get().limit }, { signal: ctrl.signal })
      ).results
      updateTab(tab.id, { lastQuery: query })
    }
  } catch (e) {
    results = [
      {
        error: message(e),
        statement: query,
        columns: [],
        rows: [],
        affected: 0,
        truncated: false,
        ms: 0,
      },
    ]
  } finally {
    running.delete(tab.id)
    updateTab(tab.id, { running: false })
  }
  showResults(tab.id, results, Math.round(performance.now() - start))
}

let describeSeq = 0

export async function describeObject(conn: Conn, node: TreeNode) {
  const tab = activeTab()
  if (!tab) return
  const seq = ++describeSeq
  try {
    const { results } = await api.connections.describe({
      id: conn.id,
      object: node.object ?? node.name,
      database: node.database ?? '',
    })
    if (seq === describeSeq) showResults(tab.id, results)
  } catch (e) {
    if (seq === describeSeq) {
      showResults(tab.id, [{ error: message(e), columns: [], rows: [], affected: 0, truncated: false, ms: 0 }])
    }
  }
}

export function setActiveObject(key: string | null) {
  set({ activeObject: key })
}

export function setFilter(filter: string) {
  set({ filter })
}

export function setView(view: 'grid' | 'json') {
  set({ view })
}

export function forgetTree(id: string) {
  set((s) => {
    const trees = { ...s.trees }
    delete trees[id]
    return { trees }
  })
}

export function setConns(conns: Conn[]) {
  set({ conns })
}
