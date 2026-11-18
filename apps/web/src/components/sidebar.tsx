import { cn } from 'cn'
import { ChevronDown, ChevronRight, Pencil, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  setFilter,
  toggleExpanded,
  toggleFolder,
  useApp,
} from '@/lib/state'
import { appendToEditor } from './editor'
import { ThemeToggle } from './theme-toggle'

const letters: Record<string, string> = {
  postgres: 'P',
  mongo: 'M',
  mysql: 'My',
  sqlite: 'Li',
  sqlserver: 'Ms',
  redis: 'R',
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

export function KindIcon({ kind, strong }: { kind: string; strong?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-sm px-0.5 font-mono text-[9px] font-bold leading-none',
        strong ? 'bg-highlight text-highlight-foreground' : 'bg-muted text-muted-foreground',
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

const row =
  'flex h-6 w-full cursor-pointer select-none items-center gap-1.5 rounded px-1.5 text-left text-[13px] hover:bg-muted'

export function Sidebar({ onAdd, onEdit }: { onAdd: () => void; onEdit: (c: Conn) => void }) {
  const conns = useApp((s) => s.conns)
  const collapsed = useApp((s) => s.collapsed)
  const filter = useApp((s) => s.filter)
  const loaded = useApp((s) => s.loaded)
  const loadError = useApp((s) => s.loadError)

  // A name like "li3/dev/db_bvt_v2" puts the connection in folder "li3".
  const folders = new Map<string, Conn[]>()
  for (const c of conns) {
    const slash = c.name.indexOf('/')
    const folder = slash > 0 ? c.name.slice(0, slash) : ''
    folders.set(folder, [...(folders.get(folder) ?? []), c])
  }

  return (
    <aside className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="font-bold tracking-tight">
          altivola<span className="highlight ml-0.5">db</span>
        </span>
        <div className="flex items-center">
          <ThemeToggle />
          <Button size="icon-sm" variant="ghost" title="New connection" onClick={onAdd}>
            <Plus />
          </Button>
        </div>
      </div>
      <div className="p-2">
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables…"
          className="h-7 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-4" role="tree">
        {loadError && <p className="px-2 text-xs text-destructive">{loadError}</p>}
        {loaded && !conns.length && !loadError && (
          <p className="px-2 text-xs text-muted-foreground">No connections yet. Click + to add one.</p>
        )}
        {[...folders].map(([folder, list]) => {
          if (!folder) return list.map((c) => <ConnNode key={c.id} conn={c} label={c.name} depth={0} onEdit={onEdit} />)
          const key = `f:${folder}`
          const open = !collapsed.includes(key)
          return (
            <div key={key}>
              <button
                type="button"
                className={cn(row, 'font-medium')}
                onClick={() => toggleFolder(key)}
                aria-expanded={open}
              >
                {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                <span className="truncate">{folder}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{list.length}</span>
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

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={open}
        title={`${conn.name} (${conn.kind}${conn.readOnly ? ', read-only' : ''})`}
        style={{ paddingLeft: 6 + pad }}
        className={cn(row, 'group', active && 'bg-muted font-semibold')}
        onClick={() => {
          if (active) {
            toggleExpanded(key)
            if (!useApp.getState().trees[conn.id]) void loadTree(conn)
          } else selectConnection(conn)
        }}
        onKeyDown={(e) => e.key === 'Enter' && selectConnection(conn)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <KindIcon kind={conn.kind} strong={active} />
        <span className="truncate">{label}</span>
        {conn.readOnly && <span className="rounded border px-1 text-[9px] text-muted-foreground">RO</span>}
        <button
          type="button"
          title="Edit connection"
          className="ml-auto hidden rounded p-0.5 hover:bg-background group-hover:block"
          onClick={(e) => {
            e.stopPropagation()
            onEdit(conn)
          }}
        >
          <Pencil className="size-3" />
        </button>
      </div>
      {open && (
        <div>
          {(!tree || tree.loading) && (
            <p className="py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: 28 + pad }}>
              Loading…
            </p>
          )}
          {tree?.error && (
            <div className="py-0.5 text-xs" style={{ paddingLeft: 28 + pad }}>
              <p className="whitespace-pre-wrap text-destructive">{tree.error}</p>
              <Button size="xs" variant="outline" className="mt-1" onClick={() => loadTree(conn)}>
                Retry
              </Button>
            </div>
          )}
          {tree?.nodes && (
            <>
              <button
                type="button"
                className="flex items-center gap-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                style={{ paddingLeft: 28 + pad }}
                onClick={() => loadTree(conn)}
              >
                <RefreshCw className="size-3" /> refresh
              </button>
              {tree.nodes.map((g) => (
                <GroupNode key={g.name} conn={conn} group={g} pad={pad} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function GroupNode({ conn, group, pad }: { conn: Conn; group: TreeNode; pad: number }) {
  const key = `g:${conn.id}:${group.name}`
  const filter = useApp((s) => s.filter.trim().toLowerCase())
  const expanded = useApp((s) => s.expanded.includes(key))
  const activeObject = useApp((s) => s.activeObject)
  const all = group.children ?? []
  const children = filter ? all.filter((c) => c.name.toLowerCase().includes(filter)) : all
  if (filter && !children.length) return null
  const open = filter ? true : expanded

  return (
    <div>
      <button
        type="button"
        className={row}
        style={{ paddingLeft: 22 + pad }}
        aria-expanded={open}
        onClick={() => {
          toggleExpanded(key)
          if (hasDbSelect(conn) && activeConn()?.id === conn.id) setDatabase(group.name)
        }}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <KindIcon kind={group.kind} />
        <span className="truncate">{group.name}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{all.length}</span>
      </button>
      {open &&
        children.map((child) => {
          const ckey = `o:${conn.id}:${group.name}:${child.name}`
          return (
            <button
              key={ckey}
              type="button"
              title="Click to describe, double-click to query"
              className={cn(row, activeObject === ckey && 'bg-highlight text-highlight-foreground hover:bg-highlight')}
              style={{ paddingLeft: 40 + pad }}
              onClick={() => {
                setActiveObject(ckey)
                if (activeConn()?.id !== conn.id) selectConnection(conn, { expand: false })
                if (conn.kind === 'mongo') setDatabase(child.database ?? '')
                if (conn.kind === 'redis') setDatabase(group.name)
                void describeObject(conn, child)
              }}
              onDoubleClick={() => queryObject(conn, child)}
            >
              <KindIcon kind={child.kind} />
              <span className="truncate">{child.name}</span>
            </button>
          )
        })}
    </div>
  )
}
