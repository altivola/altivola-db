import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type Conn, message } from '@/lib/api'
import { closeTab, forgetTree, loadConnections, selectConnection, setConns, useApp } from '@/lib/state'

type Status = { text: string; kind?: 'ok' | 'err' }

/** Create (conn undefined) or edit a connection. */
export function ConnDialog({ conn, onClose }: { conn?: Conn; onClose: () => void }) {
  const [name, setName] = useState(conn?.name ?? '')
  const [url, setUrl] = useState(conn?.url ?? '')
  const [readOnly, setReadOnly] = useState(conn?.readOnly ?? false)
  const [status, setStatus] = useState<Status>({ text: '' })
  const [busy, setBusy] = useState(false)
  const input = () => ({ ...(conn ? { id: conn.id } : {}), name, url, readOnly })

  async function test() {
    setStatus({ text: 'Connecting…' })
    try {
      const r = await api.connections.test(input())
      setStatus({ text: `Connected in ${r.ms} ms`, kind: 'ok' })
    } catch (e) {
      setStatus({ text: message(e), kind: 'err' })
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const saved = await api.connections.save(input())
      forgetTree(saved.id)
      setConns(await api.connections.list())
      onClose()
      selectConnection(saved)
    } catch (err) {
      setStatus({ text: message(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!conn || !confirm(`Delete connection "${conn.name}"? Its query tabs are closed too.`)) return
    try {
      await api.connections.remove({ id: conn.id })
      for (const t of useApp.getState().tabs.filter((x) => x.connId === conn.id)) closeTab(t.id)
      onClose()
      await loadConnections()
    } catch (e) {
      setStatus({ text: message(e), kind: 'err' })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{conn ? 'Edit connection' : 'New connection'}</DialogTitle>
            <DialogDescription>
              A name like <code>team/dev/app</code> puts the connection in a <code>team</code> folder.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="conn-name">Name</Label>
            <Input
              id="conn-name"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="local/postgres"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="conn-url">URL</Label>
            <Input
              id="conn-url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="postgres://user:pass@localhost:5432/app"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              postgres://, mysql://, mariadb://, sqlserver://, sqlite:///path/to/file.db, mongodb:// or redis://. Saved
              in plain text in your config folder (file mode 0600).
            </p>
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={readOnly} onCheckedChange={(v) => setReadOnly(v === true)} />
            Read-only (refuse writes, also for MCP)
          </Label>
          {status.text && (
            <p
              className={
                status.kind === 'err'
                  ? 'whitespace-pre-wrap text-sm text-destructive'
                  : status.kind === 'ok'
                    ? 'text-sm text-green-700 dark:text-green-400'
                    : 'text-sm text-muted-foreground'
              }
            >
              {status.text}
            </p>
          )}
          <DialogFooter className="sm:justify-between">
            <div>
              {conn && (
                <Button type="button" variant="destructive" onClick={remove}>
                  Delete
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={test}>
                Test
              </Button>
              <Button type="submit" disabled={busy}>
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
