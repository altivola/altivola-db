import { cn } from 'cn'
import { History, Lock, Play, Plus, Square, X } from 'lucide-react'
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
  openDialog,
  type QTab,
  runQuery,
  setDatabase,
  setLimit,
  useApp,
} from '@/lib/state'
import { currentText, QueryEditor, wholeText } from './editor'
import { HistoryDialog } from './history-dialog'
import { Results } from './results'
import { KindIcon, StatusDot } from './sidebar'
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
  const dialog = useApp((s) => s.dialog)
  const [analyze, setAnalyze] = useState(false)

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TopBar tab={tab} conn={conn} />
      <div className="min-h-0 flex-1 p-3">
        <ResizablePanelGroup orientation="vertical" id="altivola-db-editor">
          <ResizablePanel defaultSize="38%" minSize="90px">
            <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card">
              <EditorBar tab={tab} conn={conn} analyze={analyze} setAnalyze={setAnalyze} />
              <div className="min-h-0 flex-1">
                <QueryEditor onRun={(mode) => run(mode)} />
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle className="h-3! bg-transparent" />
          <ResizablePanel minSize="120px">
            <Results />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      {dialog === 'history' && conn && <HistoryDialog conn={conn} onClose={() => openDialog(null)} />}
      {dialog === 'transfer' && conn && <TransferDialog src={conn} onClose={() => openDialog(null)} />}
    </div>
  )
}

function TopBar({ tab, conn }: { tab: QTab | undefined; conn: Conn | undefined }) {
  const busy = !!tab?.running
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <QueryTabs />
      {conn && (
        <span
          className="flex max-w-72 shrink-0 items-center gap-2 rounded-full border border-input px-3 py-1 text-xs text-muted-foreground"
          title={conn.readOnly ? 'Read-only: writes are refused' : 'Read and write'}
        >
          <StatusDot connId={conn.id} />
          <span className="truncate">
            {conn.name} · {conn.kind}
          </span>
          {conn.readOnly && <Lock className="size-3 shrink-0" aria-label="read-only" />}
        </span>
      )}
      {busy && tab ? (
        <Button size="sm" variant="destructive" onClick={() => cancelRun(tab.id)}>
          <Square /> Cancel
        </Button>
      ) : (
        <Button
          size="sm"
          variant="highlight"
          disabled={!conn}
          onClick={() => run('block')}
          title="Run the selection or the block at the cursor"
        >
          <Play className="fill-current" /> Run <span className="font-medium opacity-60">{mac ? '⌘↵' : 'Ctrl ↵'}</span>
        </Button>
      )}
    </div>
  )
}

const mac = /Mac|iPhone|iPad/.test(navigator.platform)

function EditorBar(props: {
  tab: QTab | undefined
  conn: Conn | undefined
  analyze: boolean
  setAnalyze: (v: boolean) => void
}) {
  const { tab, conn, analyze, setAnalyze } = props
  const limit = useApp((s) => s.limit)
  const tree = useApp((s) => (conn ? s.trees[conn.id] : undefined))
  const busy = !!tab?.running
  const canDump = conn?.kind === 'postgres' || conn?.kind === 'mongo'
  const dbNames = tree?.nodes?.map((n) => n.name) ?? []
  if (tab?.db && !dbNames.includes(tab.db)) dbNames.push(tab.db)
  const select = 'h-6 rounded-md border border-input bg-background px-1.5 text-xs'

  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5 text-xs">
      {conn && hasDbSelect(conn) && (
        <select
          value={tab?.db ?? ''}
          onChange={(e) => setDatabase(e.target.value)}
          title={conn.kind === 'redis' ? 'Redis database' : 'MongoDB database'}
          className={cn(select, 'mr-1')}
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
        size="xs"
        variant="ghost"
        disabled={!conn || busy}
        onClick={() => run('all')}
        title={`Run the whole editor (${mac ? '⌘⇧↵' : 'Ctrl+Shift+Enter'})`}
      >
        Run all
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={!conn || busy || conn.kind === 'redis'}
        onClick={() => run('explain', analyze)}
      >
        Explain
      </Button>
      <Label
        className="gap-1.5 px-1 text-xs font-normal text-muted-foreground"
        title="Run the statement for real timings (Postgres, MySQL and SQL Server roll it back)"
      >
        <Checkbox checked={analyze} onCheckedChange={(v) => setAnalyze(v === true)} /> analyze
      </Label>
      <span className="flex-1" />
      <Label className="gap-1.5 px-1 text-xs font-normal text-muted-foreground">
        Limit
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={select}>
          {limits.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Label>
      <Button size="xs" variant="ghost" disabled={!conn} onClick={() => openDialog('history')}>
        <History /> History
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={!canDump}
        onClick={() => openDialog('transfer')}
        title={
          conn && !canDump
            ? 'Dump and import work for Postgres and MongoDB'
            : 'Copy this database into another connection, dump it to a file, or import a dump'
        }
      >
        Dump / Import
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
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Query tabs">
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
              'group flex h-8 max-w-56 shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-xs',
              on
                ? 'border-input bg-muted font-medium'
                : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {c && <KindIcon kind={c.kind} />}
            <span className="truncate">{label(t)}</span>
            {t.running && <span className="size-1.5 animate-pulse rounded-full bg-foreground" title="Running" />}
            <button
              type="button"
              title="Close tab"
              aria-label="Close tab"
              className={cn(
                'rounded p-0.5 hover:bg-background',
                on ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70',
              )}
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
        aria-label="New query tab"
        disabled={!conn}
        onClick={() => conn && newTab(conn)}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
