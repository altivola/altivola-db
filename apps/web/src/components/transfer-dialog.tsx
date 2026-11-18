import { cn } from 'cn'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { api, type Conn, dumpURL, type Job, message, uploadImport } from '@/lib/api'
import { forgetTree, useApp } from '@/lib/state'
import { storage } from '@/lib/storage'

type Action = 'dump' | 'import' | 'copy'
type Mode = 'all' | 'schema' | 'data'

function isLocalURL(u: string, kind: Conn['kind']) {
  if (kind === 'sqlite') return true
  const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/?]*)/i.exec(u)
  const hosts = m?.[1] ? m[1].split(',') : ['localhost']
  return hosts.every((h) => /^(localhost|127(\.\d+){3}|\[::1\]|host\.docker\.internal)(:\d+)?$/i.test(h))
}

const actions: Record<Action, { label: string; button: string; intro: (src: Conn) => string }> = {
  dump: {
    label: 'Dump to file',
    button: 'Download',
    intro: (src) => `Dump ${src.name} to a file. Your browser saves it in its download folder.`,
  },
  import: { label: 'Import file', button: 'Import', intro: (src) => `Import a dump file into ${src.name}.` },
  copy: {
    label: 'Copy to connection',
    button: 'Copy',
    intro: (src) => `Copy ${src.name} straight into another connection of the same kind.`,
  },
}

/** One job at a time, kept while the dialog is closed so a running copy can be watched again. */
let lastJob: Job | null = null

export function TransferDialog({ src, onClose }: { src: Conn; onClose: () => void }) {
  const conns = useApp((s) => s.conns)
  const [action, setAction] = useState<Action>(() => storage.get('copyAction', 'dump'))
  const [mode, setMode] = useState<Mode>('all')
  const [schemas, setSchemas] = useState('')
  const [target, setTarget] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<{ text: string; kind?: 'ok' | 'err' }>({ text: '' })
  const [job, setJob] = useState<Job | null>(lastJob?.state === 'running' ? lastJob : null)
  const logRef = useRef<HTMLPreElement>(null)
  const running = job?.state === 'running'

  const targets = useMemo(
    () =>
      conns
        .filter((c) => c.kind === src.kind && c.id !== src.id && !c.readOnly)
        // dev into local is the usual case
        .sort((a, b) => Number(isLocalURL(b.url, b.kind)) - Number(isLocalURL(a.url, a.kind))),
    [conns, src],
  )
  useEffect(() => {
    if (!targets.some((t) => t.id === target)) setTarget(targets[0]?.id ?? '')
  }, [targets, target])

  // Polls the job until it ends.
  useEffect(() => {
    if (job?.state !== 'running') return
    const timer = setInterval(async () => {
      try {
        const next = await api.transfer.job({ id: job.id })
        lastJob = next
        setJob(next)
      } catch (e) {
        setStatus({ text: message(e), kind: 'err' })
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [job])

  useEffect(() => {
    const log = logRef.current
    if (log && log.scrollTop + log.clientHeight >= log.scrollHeight - 40) log.scrollTop = log.scrollHeight
  })

  useEffect(() => {
    if (!job || job.state === 'running') return
    const secs = Math.round((new Date(job.finished ?? Date.now()).getTime() - new Date(job.started).getTime()) / 1000)
    const warn = job.warnings.length ? `, ${job.warnings.length} warning(s), see the log` : ''
    if (job.state === 'done') {
      setStatus({ text: `Done in ${secs}s${warn}.`, kind: 'ok' })
      const t = conns.find((c) => c.name === job.target)
      if (t) forgetTree(t.id)
    } else if (job.state === 'cancelled') setStatus({ text: 'Stopped. The target may be half written.', kind: 'err' })
    else setStatus({ text: job.error ?? 'failed', kind: 'err' })
  }, [job, conns])

  const t = action === 'import' ? src : conns.find((c) => c.id === target)
  const writes = action !== 'dump'
  const remote = writes && t && !isLocalURL(t.url, t.kind)
  const objs = src.kind === 'mongo' ? 'collections' : 'tables'
  let effect = ''
  if (writes && t) {
    effect =
      mode === 'data'
        ? `Rows of matching ${objs} in ${t.name} are deleted first.`
        : `Matching ${objs} in ${t.name} are dropped and recreated.`
    if (action === 'import' && src.kind === 'postgres') effect += ' A plain .sql file runs as it is, whatever the mode.'
  } else if (action === 'dump') {
    effect =
      src.kind === 'mongo'
        ? 'A .mongo.gz file altivola-db can import again.'
        : 'A pg_dump custom-format .dump file; pg_restore reads it too.'
  }
  const blocked =
    action === 'import' && src.readOnly
      ? `${src.name} is read-only, so nothing can be imported into it.`
      : action === 'copy' && !targets.length
        ? 'no target'
        : ''

  const params = () => ({ mode, schemas: src.kind === 'postgres' ? schemas : '' })

  async function start(e: React.FormEvent) {
    e.preventDefault()
    setStatus({ text: '' })
    if (action === 'dump') {
      setStatus({ text: 'Checking the connection…' })
      try {
        const { file: name } = await api.connections.dumpCheck({ id: src.id, ...params() })
        const a = document.createElement('a')
        a.href = dumpURL(src.id, params())
        a.download = name
        document.body.append(a)
        a.click()
        a.remove()
        setStatus({
          text: `Downloading ${name}. Watch your browser's downloads; big databases take a while.`,
          kind: 'ok',
        })
      } catch (err) {
        setStatus({ text: message(err), kind: 'err' })
      }
      return
    }
    if (!t) return
    const what = { all: 'everything', schema: 'the schema', data: 'the data' }[mode]
    if (action === 'import') {
      if (!file) return setStatus({ text: 'Pick a dump file first', kind: 'err' })
      if (!confirm(`Import ${file.name} into ${t.name}? ${effect}`)) return
      setStatus({ text: `Uploading ${file.name}…` })
      try {
        const j = await uploadImport(src.id, file, { ...params(), confirm: confirmName })
        lastJob = j
        setJob(j)
        setStatus({ text: 'Importing…' })
      } catch (err) {
        setStatus({ text: message(err), kind: 'err' })
      }
      return
    }
    if (!confirm(`Copy ${what} of ${src.name} into ${t.name}? ${effect}`)) return
    try {
      const j = await api.transfer.copy({
        source: src.id,
        target: t.id,
        mode,
        schemas: schemas
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        confirm: confirmName,
      })
      lastJob = j
      setJob(j)
      setStatus({ text: 'Copying…' })
    } catch (err) {
      setStatus({ text: message(err), kind: 'err' })
    }
  }

  const elapsed = job && running ? Math.round((Date.now() - new Date(job.started).getTime()) / 1000) : 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={start} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Dump / Import</DialogTitle>
          </DialogHeader>
          <div className="flex overflow-hidden rounded-md border text-sm">
            {(Object.keys(actions) as Action[]).map((a) => (
              <button
                key={a}
                type="button"
                disabled={running}
                onClick={() => {
                  setAction(a)
                  storage.set('copyAction', a)
                  setStatus({ text: '' })
                }}
                className={cn('flex-1 px-3 py-1.5', action === a ? 'bg-foreground text-background' : 'hover:bg-muted')}
              >
                {actions[a].label}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{actions[action].intro(src)}</p>

          {action === 'copy' &&
            (targets.length ? (
              <div className="grid gap-1.5">
                <Label htmlFor="copy-target">Into</Label>
                <select
                  id="copy-target"
                  value={target}
                  disabled={running}
                  onChange={(e) => setTarget(e.target.value)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {targets.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {isLocalURL(c.url, c.kind) ? '  (local)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No other writable connection of this kind. Add your local database with + first, e.g.
                postgres://postgres:pass@localhost:5432/app (the database is created if it does not exist).
              </p>
            ))}

          {action === 'import' && (
            <div className="grid gap-1.5">
              <Label htmlFor="copy-file">File</Label>
              <Input
                id="copy-file"
                type="file"
                disabled={running}
                accept={src.kind === 'mongo' ? '.gz' : '.dump,.sql,.backup'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
          )}

          <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)} disabled={running} className="gap-2">
            {(
              [
                ['all', 'Everything: schema and data'],
                ['schema', 'Schema only: tables, indexes, functions, no rows'],
                ['data', 'Data only: rows of the tables'],
              ] as const
            ).map(([v, label]) => (
              <Label key={v} className="flex items-center gap-2 font-normal">
                <RadioGroupItem value={v} />
                {label}
              </Label>
            ))}
          </RadioGroup>
          {(blocked && blocked !== 'no target') || effect ? (
            <p className="text-sm text-muted-foreground">{blocked && blocked !== 'no target' ? blocked : effect}</p>
          ) : null}

          {src.kind === 'postgres' && (
            <div className="grid gap-1.5">
              <Label htmlFor="copy-schemas">Schemas</Label>
              <Input
                id="copy-schemas"
                value={schemas}
                disabled={running}
                onChange={(e) => setSchemas(e.target.value)}
                placeholder="all schemas, or e.g. public, mobile_data"
                autoComplete="off"
              />
            </div>
          )}
          {remote && t && (
            <div className="grid gap-1.5">
              <Label htmlFor="copy-confirm">{t.name} is not on this machine. Type its name to overwrite it</Label>
              <Input
                id="copy-confirm"
                value={confirmName}
                placeholder={t.name}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {job && (
            <pre ref={logRef} className="max-h-64 overflow-auto rounded border bg-muted p-2 font-mono text-[11px]">
              {job.dropped ? `… ${job.dropped} earlier lines\n` : ''}
              {job.log.join('\n')}
            </pre>
          )}
          {(status.text || running) && (
            <p
              className={cn(
                'whitespace-pre-wrap text-sm',
                status.kind === 'err' && 'text-destructive',
                status.kind === 'ok' && 'text-green-700 dark:text-green-400',
              )}
            >
              {running ? `${job?.target && action === 'import' ? 'Importing' : 'Working'}… ${elapsed}s` : status.text}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {running && job && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => api.transfer.cancel({ id: job.id }).catch(() => {})}
              >
                Stop
              </Button>
            )}
            <Button type="submit" disabled={running || !!blocked}>
              {actions[action].button}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
