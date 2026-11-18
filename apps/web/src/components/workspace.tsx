import { cn } from 'cn'
import { History, Play, Plus, Square, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import type { Conn } from '@/lib/api'
import {
  activateTab,
  activeConn,
  cancelRun,
  closeTab,
  hasDbSelect,
  newTab,
  type QTab,
  runQuery,
  setDatabase,
  setLimit,
  useApp,
} from '@/lib/state'
import { currentText, QueryEditor, wholeText } from './editor'
import { HistoryDialog } from './history-dialog'
import { Results } from './results'
import { KindIcon } from './sidebar'
import { TransferDialog } from './transfer-dialog'

const limits = [100, 500, 1000, 5000, 20000]

function run(mode: 'block' | 'all' | 'explain', analyze = false) {
  const s = useApp.getState()
  const tab = s.tabs.find((t) => t.id === s.active)
  if (!tab) return
  const text = mode === 'all' ? wholeText() : currentText()
  void runQuery(tab, text, { explain: mode === 'explain', analyze })
}

export function Workspace() {
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.active))
  const conn = useApp((s) => activeConn(s))
  const [analyze, setAnalyze] = useState(false)
  const [dialog, setDialog] = useState<'history' | 'transfer' | null>(null)

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Toolbar
        tab={tab}
        conn={conn}
        analyze={analyze}
        setAnalyze={setAnalyze}
        onHistory={() => setDialog('history')}
        onTransfer={() => setDialog('transfer')}
      />
      <QueryTabs />
      <ResizablePanelGroup orientation="vertical" id="altivola-db-editor" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="38%" minSize="60px">
          <QueryEditor onRun={(mode) => run(mode)} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize="120px">
          <Results />
        </ResizablePanel>
      </ResizablePanelGroup>
      {dialog === 'history' && conn && <HistoryDialog conn={conn} onClose={() => setDialog(null)} />}
      {dialog === 'transfer' && conn && <TransferDialog src={conn} onClose={() => setDialog(null)} />}
    </div>
  )
}

function Toolbar(props: {
  tab: QTab | undefined
  conn: Conn | undefined
  analyze: boolean
  setAnalyze: (v: boolean) => void
  onHistory: () => void
  onTransfer: () => void
}) {
  const { tab, conn, analyze, setAnalyze } = props
  const limit = useApp((s) => s.limit)
  const tree = useApp((s) => (conn ? s.trees[conn.id] : undefined))
  const busy = !!tab?.running
  const canDump = conn?.kind === 'postgres' || conn?.kind === 'mongo'
  const dbNames = tree?.nodes?.map((n) => n.name) ?? []
  if (tab?.db && !dbNames.includes(tab.db)) dbNames.push(tab.db)

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
      <span
        className="max-w-64 truncate px-1 text-sm font-semibold"
        title={conn ? `${conn.kind}${conn.readOnly ? ', read-only' : ''}` : undefined}
      >
        {conn ? conn.name : 'No connection selected'}
      </span>
      {conn && hasDbSelect(conn) && (
        <select
          value={tab?.db ?? ''}
          onChange={(e) => setDatabase(e.target.value)}
          title={conn.kind === 'redis' ? 'Redis database' : 'MongoDB database'}
          className="h-7 rounded-md border bg-background px-1.5 text-xs"
        >
          <option value="">(database from URL)</option>
          {dbNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
      <Button
        size="sm"
        disabled={!conn || busy}
        onClick={() => run('block')}
        title="Run the selection or the block at the cursor (Ctrl/Cmd+Enter)"
      >
        <Play /> Run
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!conn || busy}
        onClick={() => run('all')}
        title="Run the whole editor (Ctrl/Cmd+Shift+Enter)"
      >
        Run all
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!conn || busy || conn.kind === 'redis'}
        onClick={() => run('explain', analyze)}
      >
        Explain
      </Button>
      <Label
        className="gap-1.5 text-xs font-normal"
        title="Run the statement for real timings (Postgres, MySQL and SQL Server roll it back)"
      >
        <Checkbox checked={analyze} onCheckedChange={(v) => setAnalyze(v === true)} /> analyze
      </Label>
      {busy && tab && (
        <Button size="sm" variant="destructive" onClick={() => cancelRun(tab.id)}>
          <Square /> Cancel
        </Button>
      )}
      <span className="flex-1" />
      <Label className="gap-1.5 text-xs font-normal">
        Limit
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="h-7 rounded-md border bg-background px-1.5 text-xs"
        >
          {limits.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Label>
      <Button size="sm" variant="ghost" disabled={!conn} onClick={props.onHistory}>
        <History /> History
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!canDump}
        onClick={props.onTransfer}
        title={
          conn && !canDump
            ? 'Dump and import work for Postgres and MongoDB'
            : 'Copy this database into another connection, dump it to a file, or import a dump'
        }
      >
        Dump / Import…
      </Button>
    </div>
  )
}

function QueryTabs() {
  const tabs = useApp((s) => s.tabs)
  const active = useApp((s) => s.active)
  const conns = useApp((s) => s.conns)
  const conn = useApp((s) => activeConn(s))

  const label = (t: QTab) => {
    const c = conns.find((x) => x.id === t.connId)
    let l = c?.name ?? '?'
    if (t.db) l += ` · ${t.db}`
    const same = tabs.filter((x) => x.connId === t.connId)
    if (same.length > 1) l += ` (${same.indexOf(t) + 1})`
    return l
  }

  return (
    <div
      className="flex items-end gap-0.5 overflow-x-auto border-b bg-muted/50 px-1 pt-1"
      role="tablist"
      aria-label="Query tabs"
    >
      {tabs.map((t) => {
        const c = conns.find((x) => x.id === t.connId)
        const on = t.id === active
        return (
          <div
            key={t.id}
            role="tab"
            tabIndex={0}
            aria-selected={on}
            title={label(t)}
            onClick={() => activateTab(t.id)}
            onKeyDown={(e) => e.key === 'Enter' && activateTab(t.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
            className={cn(
              'group flex max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 py-1 text-xs',
              on ? 'bg-background font-medium' : 'border-transparent text-muted-foreground hover:bg-background/60',
            )}
          >
            {c && <KindIcon kind={c.kind} strong={on} />}
            <span className="truncate">{label(t)}</span>
            {t.running && <span className="size-1.5 animate-pulse rounded-full bg-foreground" title="Running" />}
            <button
              type="button"
              title="Close tab"
              className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        title="New query tab for this connection"
        disabled={!conn}
        onClick={() => conn && newTab(conn)}
        className="mb-0.5 rounded p-1 text-muted-foreground hover:bg-background disabled:opacity-40"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
