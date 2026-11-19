import '@/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CommandPalette } from '@/components/command-palette'
import { ConnDialog } from '@/components/conn-dialog'
import { Sidebar } from '@/components/sidebar'
import { ThemeToggle } from '@/components/theme-toggle'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Workspace } from '@/components/workspace'
import type { Conn } from '@/lib/api'
import { loadConnections } from '@/lib/state'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

const mac = /Mac|iPhone|iPad/.test(navigator.platform)

function App() {
  // undefined: closed, null: a new connection, Conn: editing that one.
  const [editing, setEditing] = useState<Conn | null | undefined>(undefined)
  const [palette, setPalette] = useState(false)
  const newConnection = useCallback(() => setEditing(null), [])

  useEffect(() => {
    void loadConnections()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b px-3 py-2">
        <div className="flex flex-1 items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded-md bg-highlight text-sm font-semibold text-highlight-foreground"
          >
            a
          </span>
          <span className="text-sm font-semibold">altivola-db</span>
        </div>
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="flex h-8 w-full max-w-[440px] items-center gap-2 rounded-lg border border-input bg-muted px-3 text-sm text-muted-foreground hover:text-foreground"
        >
          <Search className="size-3.5" />
          <span className="truncate">Jump to a table, connection or command</span>
          <kbd className="ml-auto rounded border border-input px-1.5 font-sans text-[11px]">
            {mac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
        <div className="flex flex-1 justify-end">
          <ThemeToggle />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" id="altivola-db-layout">
          <ResizablePanel defaultSize="270px" minSize="180px" maxSize="50%">
            <Sidebar onAdd={newConnection} onEdit={(c) => setEditing(c)} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize="40%">
            <Workspace />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} onNewConnection={newConnection} />
      {editing !== undefined && <ConnDialog conn={editing ?? undefined} onClose={() => setEditing(undefined)} />}
      <Toaster position="bottom-center" />
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
