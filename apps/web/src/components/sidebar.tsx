import { cn } from 'cn'
import { ChevronDown, ChevronRight, Lock, Pencil, Plus, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import type { Conn, TreeNode } from '@/lib/api'
import {
  activeConn,
  describeObject,
  hasDbSelect,
  loadTree,
  runQuery,
  selectConnection,
  setActiveObject,
  setDatabase,
  toggleExpanded,
  toggleFolder,
  useApp,
} from '@/lib/state'
import { appendToEditor } from './editor'

const letters: Record<string, string> = {
  postgres: 'PG',
  mongo: 'MG',
  mysql: 'MY',
  sqlite: 'LI',
  d1: 'D1',
  sqlserver: 'MS',
  redis: 'RD',
  string: 'K',
  hash: 'H',
  list: 'L',
  set: 'S',
  zset: 'Z',
  stream: 'X',
  table: 'T',
  view: 'V',
  matview: 'M',
  foreign: 'F',
  collection: 'C',
  schema: 'S',
  database: 'D',
}

/** Database kinds get their own color, so a long list is easy to scan. */
const kindColors: Record<string, string> = {
  postgres: 'bg-[#e8eefc] text-[#1e40af] dark:bg-[#1b2540] dark:text-[#93b4ff]',
  mongo: 'bg-[#e7f6ee] text-[#166534] dark:bg-[#12291d] dark:text-[#6ee7a0]',
  redis: 'bg-[#fde8e8] text-[#9b1c1c] dark:bg-[#2e1515] dark:text-[#fca5a5]',
  mysql: 'bg-[#fdf0e1] text-[#9a4a00] dark:bg-[#2e2010] dark:text-[#fbbf77]',
  sqlite: 'bg-[#e0f4f4] text-[#0f6b6b] dark:bg-[#0f2626] dark:text-[#6ee0e0]',
  d1: 'bg-[#fdebd8] text-[#8a4208] dark:bg-[#2a1a0c] dark:text-[#f6a35c]',
  sqlserver: 'bg-[#f0e8fc] text-[#5b21b6] dark:bg-[#231a33] dark:text-[#c4b5fd]',
}

export function KindIcon({ kind, active }: { kind: string; active?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid h-4 min-w-5 shrink-0 place-items-center rounded-[4px] px-1 font-mono text-[9px] font-bold leading-none',
        active ? 'bg-black/10 text-black' : (kindColors[kind] ?? 'bg-muted text-muted-foreground'),
      )}
    >
      {letters[kind] ?? '?'}
    </span>
  )
}

const redisRead: Record<string, (k: string) => string> = {
  string: (k) => `GET ${k}`,
  hash: (k) => `HGETALL ${k}`,
  list: (k) => `LRANGE ${k} 0 99`,
  set: (k) => `SMEMBERS ${k}`,
  zset: (k) => `ZRANGE ${k} 0 99 WITHSCORES`,
  stream: (k) => `XRANGE ${k} - + COUNT 100`,
}

/** Puts a query for the object's first rows in the editor and runs it. */
function queryObject(conn: Conn, obj: TreeNode) {
  let q: string
  switch (conn.kind) {
    case 'mongo':
      q = `${/^[A-Za-z_$][\w$]*$/.test(obj.name) ? `db.${obj.name}` : `db.getCollection(${JSON.stringify(obj.name)})`}.find({})`
      break
    case 'redis': {
      const key = /^[^\s"'\\]+$/.test(obj.name) ? obj.name : JSON.stringify(obj.name)
      q = (redisRead[obj.kind] ?? ((k: string) => `TYPE ${k}`))(key)
      break
    }
    case 'sqlserver':
      q = `select top 100 * from ${obj.object};`
      break
    default:
      q = `select * from ${obj.object} limit 100;`
  }
  appendToEditor(q)
  const tab = useApp.getState().tabs.find((t) => t.id === useApp.getState().active)
  if (tab) void runQuery(tab, q)
}

const objectKey = (conn: Conn, group: string, name: string) => `o:${conn.id}:${group}:${name}`

/** Selects an object in the tree (opening its connection and group) and shows its columns. */
export function revealObject(conn: Conn, group: TreeNode, child: TreeNode) {
  if (activeConn()?.id !== conn.id) selectConnection(conn, { expand: false })
  toggleExpanded(`c:${conn.id}`, true)
  toggleExpanded(`g:${conn.id}:${group.name}`, true)
  const folder = conn.name.indexOf('/') > 0 ? conn.name.slice(0, conn.name.indexOf('/')) : ''
  if (folder && useApp.getState().collapsed.includes(`f:${folder}`)) toggleFolder(`f:${folder}`)
  setActiveObject(objectKey(conn, group.name, child.name))
  if (conn.kind === 'mongo') setDatabase(child.database ?? '')
  if (conn.kind === 'redis') setDatabase(group.name)
  void describeObject(conn, child)
}

const row =
  'flex h-7 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-accent'

export function Sidebar({ onAdd, onEdit }: { onAdd: () => void; onEdit: (c: Conn) => void }) {
  const conns = useApp((s) => s.conns)
  const collapsed = useApp((s) => s.collapsed)
  const loaded = useApp((s) => s.loaded)
  const loadError = useApp((s) => s.loadError)
  const activeObject = useApp((s) => s.activeObject)

  // Keep the selected object in view, also when ⌘K picked it.
  useEffect(() => {
    if (!activeObject) return
    const t = setTimeout(() => {
      document.querySelector(`[data-tree-key="${CSS.escape(activeObject)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
    return () => clearTimeout(t)
  }, [activeObject])

  // A name like "li3/dev/db_bvt_v2" puts the connection in folder "li3".
  const folders = new Map<string, Conn[]>()
  for (const c of conns) {
    const slash = c.name.indexOf('/')
    const folder = slash > 0 ? c.name.slice(0, slash) : ''
    folders.set(folder, [...(folders.get(folder) ?? []), c])
  }

  return (
    <aside className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between py-2 pr-2 pl-4">
        <span className="text-xs font-semibold text-muted-foreground">Connections</span>
        <Button size="icon-sm" variant="ghost" title="New connection" aria-label="New connection" onClick={onAdd}>
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4" role="tree">
        {loadError && <p className="px-2 text-xs text-destructive">{loadError}</p>}
        {loaded && !conns.length && !loadError && (
          <p className="px-2 text-xs text-muted-foreground">No connections yet. Click + to add one.</p>
        )}
        {[...folders].map(([folder, list]) => {
          if (!folder) return list.map((c) => <ConnNode key={c.id} conn={c} label={c.name} depth={0} onEdit={onEdit} />)
          const key = `f:${folder}`
          const open = !collapsed.includes(key)
          return (
            <div key={key} className="mt-2 first:mt-0">
              <button
                type="button"
                className={cn(row, 'h-6 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase')}
                onClick={() => toggleFolder(key)}
                aria-expanded={open}
              >
                {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                <span className="truncate">{folder}</span>
                <span className="ml-auto font-normal tracking-normal">{list.length}</span>
              </button>
              {open &&
                list.map((c) => (
                  <ConnNode key={c.id} conn={c} label={c.name.slice(folder.length + 1)} depth={1} onEdit={onEdit} />
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

export function StatusDot({ connId }: { connId: string }) {
  const tree = useApp((s) => s.trees[connId])
  const [color, title] = tree?.error
    ? ['bg-destructive', 'Could not connect']
    : tree?.loading
      ? ['animate-pulse bg-muted-foreground', 'Connecting']
      : tree?.nodes
        ? ['bg-[#3ecf8e]', 'Connected']
        : ['bg-input', 'Not opened yet']
  return <span className={cn('size-1.5 shrink-0 rounded-full', color)} title={title} />
}

function ConnNode({
  conn,
  label,
  depth,
  onEdit,
}: {
  conn: Conn
  label: string
  depth: number
  onEdit: (c: Conn) => void
}) {
  const key = `c:${conn.id}`
  const open = useApp((s) => s.expanded.includes(key))
  const active = useApp((s) => activeConn(s)?.id === conn.id)
  const tree = useApp((s) => s.trees[conn.id])
  const pad = depth * 12

  // A connection left open on the last visit loads its tree again.
  useEffect(() => {
    if (open && !tree) void loadTree(conn)
  }, [open, tree, conn])

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={open}
        title={`${conn.name} (${conn.kind}${conn.readOnly ? ', read-only' : ''})`}
        style={{ paddingLeft: 8 + pad }}
        className={cn(row, 'group', active && 'font-semibold')}
        onClick={() => {
          if (active) {
            toggleExpanded(key)
            if (!useApp.getState().trees[conn.id]) void loadTree(conn)
          } else selectConnection(conn)
        }}
        onKeyDown={(e) => e.key === 'Enter' && selectConnection(conn)}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <KindIcon kind={conn.kind} />
        <span className="truncate">{label}</span>
        {conn.readOnly && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="read-only" />}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            title="Edit connection"
            aria-label={`Edit ${conn.name}`}
            className="hidden rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(conn)
            }}
          >
            <Pencil className="size-3" />
          </button>
          <StatusDot connId={conn.id} />
        </span>
      </div>
      {open && (
        <div>
          {(!tree || tree.loading) && (
            <p className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: 30 + pad }}>
              Loading…
            </p>
          )}
          {tree?.error && (
            <div className="py-1 pr-2 text-xs" style={{ paddingLeft: 30 + pad }}>
              <p className="whitespace-pre-wrap text-destructive">{tree.error}</p>
              <Button size="xs" variant="outline" className="mt-1" onClick={() => loadTree(conn)}>
                Retry
              </Button>
            </div>
          )}
          {tree?.nodes && (
            <>
              {tree.nodes.map((g) => (
                <GroupNode key={g.name} conn={conn} group={g} pad={pad} />
              ))}
              <button
                type="button"
                className="flex items-center gap-1 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                style={{ paddingLeft: 30 + pad }}
                onClick={() => loadTree(conn)}
              >
                <RefreshCw className="size-3" /> Refresh
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function GroupNode({ conn, group, pad }: { conn: Conn; group: TreeNode; pad: number }) {
  const key = `g:${conn.id}:${group.name}`
  const open = useApp((s) => s.expanded.includes(key))
  const activeObject = useApp((s) => s.activeObject)
  const children = group.children ?? []

  return (
    <div>
      <button
        type="button"
        className={cn(row, 'text-muted-foreground hover:text-foreground')}
        style={{ paddingLeft: 24 + pad }}
        aria-expanded={open}
        onClick={() => {
          toggleExpanded(key)
          if (hasDbSelect(conn) && activeConn()?.id === conn.id) setDatabase(group.name)
        }}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span className="truncate">{group.name}</span>
        <span className="ml-auto text-[11px]">{children.length}</span>
      </button>
      {open &&
        children.map((child) => {
          const ckey = objectKey(conn, group.name, child.name)
          const on = activeObject === ckey
          return (
            <button
              key={ckey}
              type="button"
              data-tree-key={ckey}
              title="Click to describe, double-click to query"
              className={cn(
                row,
                on
                  ? 'bg-highlight font-semibold text-highlight-foreground hover:bg-highlight'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              style={{ paddingLeft: 40 + pad }}
              onClick={() => revealObject(conn, group, child)}
              onDoubleClick={() => queryObject(conn, child)}
            >
              <KindIcon kind={child.kind} active={on} />
              <span className="truncate">{child.name}</span>
            </button>
          )
        })}
    </div>
  )
}
