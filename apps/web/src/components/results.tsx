import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import { KeyRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, type Conn, message, type Result } from '@/lib/api'
import {
  asCSV,
  asJSON,
  buildOps,
  canEdit,
  cellChange,
  cellText,
  copyText,
  editableCol,
  emptyPending,
  isIns,
  numericTypes,
  originalFor,
  prettyJSON,
  type RowRef,
  withChange,
} from '@/lib/grid'
import { activeConn, type Pending, pendingCount, runQuery, setView, updateTab, useApp } from '@/lib/state'
import { CellDialog, type CellDialogState } from './cell-dialog'

const copy = async (text: string) => toast((await copyText(text)) ? 'Copied' : 'Copy failed')

export function Results() {
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.active))
  const conn = useApp((s) => activeConn(s))
  const view = useApp((s) => s.view)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)

  const r = tab?.results[tab.rtab]
  const pending = tab?.pending[tab.rtab]
  const n = pendingCount(pending)
  const hasGrid = !!r && !r.error && r.columns.length > 0
  const editable = hasGrid && canEdit(r, conn) && view !== 'json'

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new result clears the old save error
  useEffect(() => setSaveError(''), [r])

  if (!tab || !conn) {
    return <Empty>Results show up here.</Empty>
  }

  const setPending = (p: Pending | undefined) =>
    updateTab(tab.id, (t) => {
      const next = { ...t.pending }
      if (p) next[t.rtab] = p
      else delete next[t.rtab]
      return { pending: next }
    })

  async function submit() {
    if (!tab || !conn || !r?.edit || !pending) return
    const ops = buildOps(r, conn, pending)
    if (!ops.length) return setPending(undefined)
    const dels = Object.keys(pending.del).length
    if (dels && !confirm(`Delete ${dels} row${dels === 1 ? '' : 's'} from ${r.edit.object}?`)) return
    setSaving(true)
    try {
      const res = await api.connections.edit({
        id: conn.id,
        database: r.edit.database || tab.db || '',
        object: r.edit.object,
        ops,
      })
      toast(res.message || 'Saved')
      setPending(undefined)
      // Re-read only the statement behind this result: the rest of the script may write.
      const again = r.statement ?? tab.lastQuery
      if (again) await runQuery({ ...tab, pending: {} }, again, { keepPending: true })
    } catch (e) {
      setSaveError(message(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist">
          {tab.results.map((x, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === tab.rtab}
              title={x.statement}
              onClick={() => updateTab(tab.id, { rtab: i })}
              className={cn(
                'shrink-0 rounded px-2 py-0.5 text-xs',
                i === tab.rtab ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                x.error && 'text-destructive',
                x.error && i === tab.rtab && 'bg-destructive text-white',
              )}
            >
              {x.title || (tab.results.length > 1 ? `#${i + 1}` : 'Result')}
            </button>
          ))}
        </div>
        {editable && (
          <div className="flex gap-1">
            <Button size="xs" variant="outline" onClick={() => grid.addRow?.()}>
              + Row
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => grid.deleteRow?.()}
              title="Delete the selected row (Delete key)"
            >
              − Row
            </Button>
            <Button size="xs" variant="outline" onClick={() => grid.setNull?.()} title="Set the selected cell to NULL">
              NULL
            </Button>
            <Button size="xs" variant="outline" disabled={!n} onClick={() => setPending(undefined)}>
              Revert
            </Button>
            <Button size="xs" disabled={!n || saving} onClick={submit} title="Save the changes in one go">
              {n ? `Submit (${n})` : 'Submit'}
            </Button>
          </div>
        )}
        {hasGrid && !!r.docs?.length && (
          <div className="flex overflow-hidden rounded border text-xs">
            {(['grid', 'json'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  'px-2 py-0.5 capitalize',
                  view === v ? 'bg-foreground text-background' : 'hover:bg-muted',
                )}
              >
                {v === 'json' ? 'JSON' : 'Grid'}
              </button>
            ))}
          </div>
        )}
        {hasGrid && (
          <>
            <Button size="xs" variant="ghost" onClick={() => copy(asCSV(r))}>
              Copy CSV
            </Button>
            <Button size="xs" variant="ghost" onClick={() => copy(asJSON(r))}>
              Copy JSON
            </Button>
          </>
        )}
      </div>
      <div className="border-b px-3 py-1 text-xs text-muted-foreground">
        {tab.running ? (
          'Running…'
        ) : saveError ? (
          <span className="text-destructive">Not saved: {saveError}</span>
        ) : r ? (
          <Meta r={r} editable={editable} />
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {!r ? (
          <Empty>Results show up here.</Empty>
        ) : r.error ? (
          <pre className="m-3 whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/10 p-3 font-mono text-sm text-destructive">
            {r.error}
          </pre>
        ) : !hasGrid ? (
          <div className="m-3 font-mono text-sm">{r.message || 'OK'}</div>
        ) : view === 'json' && r.docs?.length ? (
          <pre className="h-full overflow-auto p-3 font-mono text-xs">{r.docs.map(prettyJSON).join('\n\n')}</pre>
        ) : (
          <Grid
            key={`${tab.id}:${tab.rtab}:${tab.results.length}`}
            r={r}
            conn={conn}
            editable={editable}
            pending={pending}
            setPending={setPending}
          />
        )}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-sm text-muted-foreground">{children}</div>
}

function Meta({ r, editable }: { r: Result; editable: boolean }) {
  const parts: string[] = []
  if (r.columns.length) parts.push(`${r.rows.length} row${r.rows.length === 1 ? '' : 's'}`)
  else if (r.affected) parts.push(`${r.affected} affected`)
  if (r.message && !r.columns.length) parts.push(r.message)
  if (r.message && r.title && r.columns.length) parts.push(r.message)
  parts.push(`${r.ms} ms`)
  return (
    <span>
      {parts.join(' · ')}
      {r.truncated && (
        <span className="text-amber-600 dark:text-amber-400">
          {' '}
          · more rows exist, raise the limit or refine the query
        </span>
      )}
      {editable && r.edit && (
        <span>
          {' · '}
          <span className="highlight">editable</span> ({r.edit.object}): double-click a cell
        </span>
      )}
    </span>
  )
}

/** The grid's actions, so the bar above it can call them. */
const grid: { addRow?: () => void; deleteRow?: () => void; setNull?: () => void } = {}

type Selected = { ref: RowRef; ci: number }

function colWidth(r: Result, ci: number): number {
  const col = r.columns[ci]
  let max = (col?.name.length ?? 4) + (col?.type ? col.type.length + 2 : 0)
  for (let i = 0; i < Math.min(r.rows.length, 200); i++)
    max = Math.max(max, Math.min(cellText(r.rows[i]?.[ci]).length, 60))
  return Math.min(Math.max(max, 4), 60) * 7.6 + 24
}

function Grid({
  r,
  conn,
  editable,
  pending,
  setPending,
}: {
  r: Result
  conn: Conn
  editable: boolean
  pending: Pending | undefined
  setPending: (p: Pending | undefined) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [sel, setSel] = useState<Selected | null>(null)
  const [editing, setEditing] = useState<Selected | null>(null)
  const [dialog, setDialog] = useState<CellDialogState | null>(null)
  const p = pending ?? emptyPending()

  const widths = useMemo(() => r.columns.map((_, i) => colWidth(r, i)), [r])
  const order = useMemo(() => {
    const idx = r.rows.map((_, i) => i)
    if (!sort) return idx
    const { col, dir } = sort
    const numeric =
      numericTypes.has(r.columns[col]?.type ?? '') ||
      r.rows.every((row) => row[col] === null || typeof row[col] === 'number')
    return idx.sort((a, b) => {
      const x = r.rows[a]?.[col]
      const y = r.rows[b]?.[col]
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      const c = numeric ? Number(x) - Number(y) : cellText(x).localeCompare(cellText(y), undefined, { numeric: true })
      return dir * c
    })
  }, [r, sort])

  const refs: RowRef[] = useMemo(
    () => [...order.map((row) => ({ row })), ...p.ins.map((_, ins) => ({ ins }))],
    [order, p.ins],
  )

  const virtual = useVirtualizer({
    count: refs.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 26,
    overscan: 20,
  })

  const nextEditable = (ci: number, dir: 1 | -1) => {
    for (let i = ci + dir; i >= 0 && i < r.columns.length; i += dir) if (editableCol(r, conn, i)) return i
    return null
  }

  const save = (ref: RowRef, ci: number, text: string, isNull: boolean) => {
    try {
      setPending(withChange(p, r, conn, ref, ci, text, isNull))
    } catch (e) {
      toast(message(e))
    }
  }

  const startEdit = (ref: RowRef, ci: number) => {
    const change = cellChange(p, ref, ci)
    const start = change ? (change.wire === null ? '' : change.text) : originalFor(r, conn, ref, ci).text
    if (start.length > 200 || start.includes('\n')) {
      setDialog({
        title: r.columns[ci]?.name ?? '',
        text: start,
        apply: (text) => save(ref, ci, text, false),
      })
      return
    }
    setEditing({ ref, ci })
  }

  grid.addRow = () => {
    const ins = p.ins.length
    setPending({ ...p, ins: [...p.ins, {}] })
    // Start after the key: keys are usually generated (serial, identity, _id).
    let ci = r.columns.findIndex((_, i) => editableCol(r, conn, i) && !r.edit?.key.includes(r.edit.columns[i] ?? ''))
    if (ci < 0) ci = nextEditable(-1, 1) ?? -1
    setTimeout(() => {
      virtual.scrollToIndex(refs.length, { align: 'end' })
      if (ci >= 0) setEditing({ ref: { ins }, ci })
    })
  }
  grid.deleteRow = () => {
    if (!sel) return toast('Select a cell of the row first')
    const ref = sel.ref
    if (isIns(ref)) setPending({ ...p, ins: p.ins.filter((_, i) => i !== ref.ins) })
    else {
      const del = { ...p.del }
      if (del[ref.row]) delete del[ref.row]
      else del[ref.row] = true
      setPending({ ...p, del })
    }
    setSel(null)
  }
  grid.setNull = () => {
    if (!sel || !editableCol(r, conn, sel.ci)) return toast('Select an editable cell first')
    save(sel.ref, sel.ci, '', true)
  }

  const valueAt = (ref: RowRef, ci: number) => {
    const change = cellChange(p, ref, ci)
    if (change) return change.value
    return isIns(ref) ? null : (r.rows[ref.row]?.[ci] ?? null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !sel) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && editable) {
      e.preventDefault()
      grid.deleteRow?.()
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault()
      void copy(cellText(valueAt(sel.ref, sel.ci)))
    }
  }

  const total = widths.reduce((a, b) => a + b, 48)
  const items = virtual.getVirtualItems()
  const padTop = items[0]?.start ?? 0
  const padBottom = virtual.getTotalSize() - (items[items.length - 1]?.end ?? 0)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the grid takes keys for its selected cell
    <div ref={scroller} tabIndex={-1} onKeyDown={onKeyDown} className="h-full overflow-auto outline-none">
      <table
        className="border-separate border-spacing-0 font-mono text-xs"
        style={{ width: total, tableLayout: 'fixed' }}
      >
        <colgroup>
          <col style={{ width: 48 }} />
          {widths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="border-b border-r px-2 py-1 text-right font-normal text-muted-foreground">#</th>
            {r.columns.map((c, i) => {
              const isKey = editable && r.edit?.key.includes(r.edit.columns[i] ?? '')
              return (
                <th
                  key={i}
                  title={
                    (c.type ? `${c.name} (${c.type})` : c.name) +
                    (editable && !editableCol(r, conn, i) ? ', read-only' : '')
                  }
                  onClick={() => setSort((s) => ({ col: i, dir: s?.col === i ? (s.dir === 1 ? -1 : 1) : 1 }))}
                  className="cursor-pointer select-none truncate border-b border-r px-2 py-1 text-left font-semibold hover:bg-background"
                >
                  {c.name}
                  {c.type && <span className="ml-1 font-normal text-muted-foreground">{c.type}</span>}
                  {isKey && <KeyRound className="ml-1 inline size-3" />}
                  {sort?.col === i && <span className="ml-1">{sort.dir > 0 ? '▲' : '▼'}</span>}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr>
              <td style={{ height: padTop }} />
            </tr>
          )}
          {items.map((item) => {
            const ref = refs[item.index] as RowRef
            const inserted = isIns(ref)
            const deleted = !inserted && !!p.del[ref.row]
            return (
              <tr key={item.key} className={cn(deleted && 'line-through opacity-50', inserted && 'bg-highlight/20')}>
                <td className="border-b border-r px-2 text-right text-muted-foreground">
                  {inserted ? '+' : ref.row + 1}
                </td>
                {r.columns.map((col, ci) => {
                  const change = cellChange(p, ref, ci)
                  const v = valueAt(ref, ci)
                  const isNull = v === null || v === undefined
                  const text = isNull ? 'NULL' : change ? change.text : cellText(v)
                  const numeric = typeof v === 'number' || numericTypes.has(col.type ?? '')
                  const selected = sel && sel.ci === ci && sameRef(sel.ref, ref)
                  const isEditing = editing && editing.ci === ci && sameRef(editing.ref, ref)
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the grid itself takes keys for the selected cell
                    <td
                      key={ci}
                      title={text.length > 60 ? text.slice(0, 500) : undefined}
                      onClick={() => setSel({ ref, ci })}
                      onDoubleClick={() => {
                        if (editable && editableCol(r, conn, ci) && !deleted) startEdit(ref, ci)
                        else setDialog({ title: col.name, text: isNull ? 'NULL' : prettyJSON(cellText(v)) })
                      }}
                      className={cn(
                        'h-[26px] truncate border-b border-r px-2',
                        isNull && 'italic text-muted-foreground',
                        numeric && !isNull && 'text-right',
                        change && 'bg-highlight text-highlight-foreground',
                        selected && 'outline-2 -outline-offset-2 outline-foreground',
                        isEditing && 'p-0',
                      )}
                    >
                      {isEditing ? (
                        <CellInput
                          initial={
                            change ? (change.wire === null ? '' : change.text) : originalFor(r, conn, ref, ci).text
                          }
                          onDone={(value, save_, move) => {
                            setEditing(null)
                            if (save_) {
                              const wasNull = change ? change.wire === null : originalFor(r, conn, ref, ci).isNull
                              // An empty input on a NULL cell stays NULL; use the NULL button to null a value.
                              save(ref, ci, value, value === '' && wasNull)
                            }
                            if (move) {
                              const next = nextEditable(ci, move)
                              if (next !== null) setTimeout(() => startEdit(ref, next))
                            }
                            scroller.current?.focus()
                          }}
                        />
                      ) : text.length > 300 ? (
                        `${text.slice(0, 300)}…`
                      ) : (
                        text
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {padBottom > 0 && (
            <tr>
              <td style={{ height: padBottom }} />
            </tr>
          )}
        </tbody>
      </table>
      {dialog && <CellDialog state={dialog} onClose={() => setDialog(null)} />}
    </div>
  )
}

const sameRef = (a: RowRef, b: RowRef) =>
  isIns(a) && isIns(b) ? a.ins === b.ins : !isIns(a) && !isIns(b) && a.row === b.row

function CellInput({
  initial,
  onDone,
}: {
  initial: string
  onDone: (value: string, save: boolean, move?: 1 | -1) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (save: boolean, move?: 1 | -1) => {
    if (done.current) return
    done.current = true
    onDone(ref.current?.value ?? '', save, move)
  }
  return (
    <input
      ref={ref}
      defaultValue={initial}
      placeholder="NULL"
      className="h-full w-full bg-background px-2 font-mono text-xs outline-2 -outline-offset-2 outline-highlight"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        } else if (e.key === 'Tab') {
          e.preventDefault()
          finish(true, e.shiftKey ? -1 : 1)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
