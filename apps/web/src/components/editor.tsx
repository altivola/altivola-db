import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentLess, insertTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { MSSQL, MySQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import type { Conn } from '@/lib/api'
import { completionSource } from '@/lib/complete'
import { activeTab, updateTab, useApp } from '@/lib/state'

/** The one editor on the page, so the toolbar and the tree can read and change it. */
export const editor: { view?: EditorView } = {}

/** The selection, or the block around the cursor. Blocks are separated by blank lines. */
export function currentText(): string {
  const view = editor.view
  if (!view) return ''
  const { from, to } = view.state.selection.main
  const doc = view.state.doc.toString()
  if (to > from) return doc.slice(from, to)
  const before = doc.slice(0, from)
  const startMatch = [...before.matchAll(/\n[ \t]*\n/g)].pop()
  const start = startMatch ? (startMatch.index ?? 0) + startMatch[0].length : 0
  const endMatch = doc.slice(from).match(/\n[ \t]*\n/)
  const end = endMatch ? from + (endMatch.index ?? 0) : doc.length
  return doc.slice(start, end)
}

export function wholeText(): string {
  return editor.view?.state.doc.toString() ?? ''
}

/** Adds text after a blank line at the end and selects it. */
export function appendToEditor(text: string) {
  const view = editor.view
  if (!view) return
  const doc = view.state.doc.toString()
  const base = doc.replace(/\s+$/, '')
  const insert = base ? `\n\n${text}` : text
  view.dispatch({
    changes: { from: base.length, to: doc.length, insert },
    selection: { anchor: base.length + insert.length - text.length, head: base.length + insert.length },
    scrollIntoView: true,
  })
  view.focus()
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--code-keyword)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--code-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.propertyName], color: 'var(--code-name)' },
  { tag: [t.typeName, t.className], color: 'var(--code-type)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--card)', color: 'var(--foreground)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--foreground)', padding: '8px 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'var(--muted-foreground)',
    border: 'none',
    paddingLeft: '6px',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--highlight) 45%, transparent) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--highlight)',
    color: 'var(--highlight-foreground)',
  },
  '.cm-completionDetail': { opacity: '0.6', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in oklab, var(--highlight) 35%, transparent)' },
})

const help = `Pick a connection on the left, then write a query.

SQL:       select * from users limit 10;
MongoDB:   db.users.find({ age: { $gt: 30 } }).sort({ name: 1 })
Redis:     GET session:42

Ctrl/Cmd+Enter runs the selection, or the block around the cursor (blocks are separated by a blank line).
Ctrl/Cmd+Shift+Enter runs everything. Tab accepts a suggestion, Ctrl+Space shows suggestions.`

function language(kind: Conn['kind'] | undefined) {
  const source = autocompletion({ override: [completionSource(kind ?? 'postgres')], activateOnTyping: true })
  switch (kind) {
    case 'mongo':
      return [javascript(), source]
    case 'redis':
      return [source]
    case 'mysql':
      return [sql({ dialect: MySQL }), source]
    case 'sqlserver':
      return [sql({ dialect: MSSQL }), source]
    case 'sqlite':
    case 'd1':
      return [sql({ dialect: SQLite }), source]
    default:
      return [sql({ dialect: PostgreSQL }), source]
  }
}

export function QueryEditor({ onRun }: { onRun: (mode: 'block' | 'all') => void }) {
  const host = useRef<HTMLDivElement>(null)
  const lang = useRef(new Compartment())
  const runRef = useRef(onRun)
  runRef.current = onRun
  const tab = useApp((s) => s.tabs.find((x) => x.id === s.active))
  const kind = useApp((s) => s.conns.find((c) => c.id === tab?.connId)?.kind)
  const tabId = tab?.id

  useEffect(() => {
    if (!host.current) return
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          placeholder(help),
          theme,
          lang.current.of(language(undefined)),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  runRef.current('block')
                  return true
                },
              },
              {
                key: 'Shift-Mod-Enter',
                run: () => {
                  runRef.current('all')
                  return true
                },
              },
              { key: 'Tab', run: (v) => acceptCompletion(v) || insertTab(v), shift: indentLess },
            ]),
          ),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            const editedTab = activeTab()?.id
            clearTimeout(saveTimer)
            saveTimer = setTimeout(() => {
              // After a tab switch the text on screen belongs to another tab; the switch saved this one.
              if (editedTab && activeTab()?.id === editedTab)
                updateTab(editedTab, { text: u.view.state.doc.toString() })
            }, 300)
          }),
        ],
      }),
    })
    editor.view = view
    return () => {
      clearTimeout(saveTimer)
      const t = activeTab()
      if (t) updateTab(t.id, { text: view.state.doc.toString() })
      view.destroy()
      editor.view = undefined
    }
  }, [])

  // A different tab: keep the old tab's text, then load the new one's text and language.
  const shown = useRef<string | undefined>(undefined)
  useEffect(() => {
    const view = editor.view
    if (!view) return
    if (shown.current && shown.current !== tabId && useApp.getState().tabs.some((x) => x.id === shown.current)) {
      updateTab(shown.current, { text: view.state.doc.toString() })
    }
    shown.current = tabId
    const text = tabId ? (activeTab()?.text ?? '') : ''
    if (view.state.doc.toString() !== text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } })
    }
    view.dispatch({ effects: lang.current.reconfigure(language(kind)) })
    view.contentDOM.setAttribute('contenteditable', tabId ? 'true' : 'false')
  }, [tabId, kind])

  return <div ref={host} className="h-full overflow-hidden" />
}
