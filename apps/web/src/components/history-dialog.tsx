import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type Conn, message } from '@/lib/api'
import { appendToEditor } from './editor'

export function HistoryDialog({ conn, onClose }: { conn: Conn; onClose: () => void }) {
  const q = useQuery({ queryKey: ['history', conn.id], queryFn: () => api.history({ conn: conn.id }), staleTime: 0 })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>History of {conn.name}</DialogTitle>
          <DialogDescription>
            Click an entry to put it back in the editor. Entries from AI agents are marked mcp.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-auto">
          {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {q.error && <p className="text-sm text-destructive">{message(q.error)}</p>}
          {q.data?.length === 0 && <p className="text-sm text-muted-foreground">No history for this connection yet.</p>}
          {q.data?.map((h, i) => (
            <button
              key={i}
              type="button"
              className="block w-full border-b px-2 py-2 text-left hover:bg-muted"
              onClick={() => {
                onClose()
                appendToEditor(h.query.trim())
              }}
            >
              <div className="mb-1 flex gap-3 text-xs text-muted-foreground">
                <span>{new Date(h.at).toLocaleString()}</span>
                <span>{h.ms} ms</span>
                <span className={h.source === 'mcp' ? 'highlight' : undefined}>{h.source}</span>
                {h.database && <span>{h.database}</span>}
                {h.error && (
                  <span className="text-destructive" title={h.error}>
                    failed
                  </span>
                )}
              </div>
              <pre className="line-clamp-4 whitespace-pre-wrap font-mono text-xs">{h.query}</pre>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
