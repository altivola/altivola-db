import { cn } from 'cn'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Conn, TreeNode } from '@/lib/api'
import { activeConn, openDialog, selectConnection, useApp } from '@/lib/state'
import { currentTheme, setTheme } from '@/lib/theme'
import { KindIcon, revealObject } from './sidebar'

type Item = {
  key: string
  label: string
  hint: string
  kind?: string
  /** The text the query is matched against. */
  text: string
  run: () => void
}

/** Every word must appear in the item's text, in any order. */
function matches(item: Item, words: string[]) {
  return words.every((w) => item.text.includes(w))
}

export function CommandPalette({
  open,
  onOpenChange,
  onNewConnection,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNewConnection: () => void
}) {
  const conns = useApp((s) => s.conns)
  const trees = useApp((s) => s.trees)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo(() => {
    const out: Item[] = []
    const conn = activeConn()
    const commands: Item[] = [
      { key: 'cmd:new', label: 'New connection', hint: 'Command', text: 'new connection add', run: onNewConnection },
      {
        key: 'cmd:theme',
        label: 'Switch light or dark',
        hint: 'Command',
        text: 'theme dark light mode switch',
        run: () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'),
      },
    ]
    if (conn) {
      commands.push({
        key: 'cmd:history',
        label: 'Query history',
        hint: conn.name,
        text: 'history queries',
        run: () => openDialog('history'),
      })
      if (conn.kind === 'postgres' || conn.kind === 'mongo')
        commands.push({
          key: 'cmd:transfer',
          label: 'Dump, import or copy database',
          hint: conn.name,
          text: 'dump import copy transfer backup restore',
          run: () => openDialog('transfer'),
        })
    }
    for (const c of conns) {
      out.push({
        key: `c:${c.id}`,
        label: c.name,
        hint: c.readOnly ? `${c.kind}, read-only` : c.kind,
        kind: c.kind,
        text: `${c.name} ${c.kind}`.toLowerCase(),
        run: () => selectConnection(c),
      })
    }
    // Tables come from the trees already loaded; a connection lists its tables once it has been opened.
    for (const c of conns) {
      for (const g of trees[c.id]?.nodes ?? []) {
        for (const child of g.children ?? []) {
          out.push(objectItem(c, g, child))
        }
      }
    }
    return [...commands.map((x) => ({ ...x, text: `${x.label} ${x.text}`.toLowerCase() })), ...out]
  }, [conns, trees, onNewConnection])

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (words.length ? items.filter((x) => matches(x, words)) : items).slice(0, 60)

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const pick = (item: Item | undefined) => {
    if (!item) return
    onOpenChange(false)
    item.run()
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[min(640px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">Jump to</DialogPrimitive.Title>
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a table, connection or command"
            aria-label="Jump to"
            className="h-12 border-b bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(i + 1, shown.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(shown[index])
              }
            }}
          />
          <div ref={list} className="min-h-0 flex-1 overflow-auto p-1.5" role="listbox" aria-label="Results">
            {!shown.length && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing found. Tables show up here once their connection has been opened.
              </p>
            )}
            {shown.map((item, i) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === index}
                data-index={i}
                onMouseMove={() => setIndex(i)}
                onClick={() => pick(item)}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm',
                  i === index && 'bg-accent',
                )}
              >
                {item.kind ? (
                  <KindIcon kind={item.kind} />
                ) : (
                  <span className="inline-block min-w-5" aria-hidden>
                    ›
                  </span>
                )}
                <span className="truncate">{item.label}</span>
                <span className="ml-auto shrink-0 truncate pl-4 text-xs text-muted-foreground">{item.hint}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ move</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function objectItem(c: Conn, g: TreeNode, child: TreeNode): Item {
  return {
    key: `o:${c.id}:${g.name}:${child.name}`,
    label: child.name,
    hint: `${c.name} · ${g.name}`,
    kind: child.kind,
    text: `${child.name} ${g.name} ${c.name}`.toLowerCase(),
    run: () => revealObject(c, g, child),
  }
}
