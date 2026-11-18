import '@/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnDialog } from '@/components/conn-dialog'
import { Sidebar } from '@/components/sidebar'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Workspace } from '@/components/workspace'
import type { Conn } from '@/lib/api'
import { loadConnections } from '@/lib/state'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

function App() {
  // undefined: closed, null: a new connection, Conn: editing that one.
  const [editing, setEditing] = useState<Conn | null | undefined>(undefined)
  useEffect(() => {
    void loadConnections()
  }, [])

  return (
    <div className="h-dvh">
      <ResizablePanelGroup orientation="horizontal" id="altivola-db-layout">
        <ResizablePanel defaultSize="260px" minSize="180px" maxSize="50%">
          <Sidebar onAdd={() => setEditing(null)} onEdit={(c) => setEditing(c)} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize="40%">
          <Workspace />
        </ResizablePanel>
      </ResizablePanelGroup>
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
