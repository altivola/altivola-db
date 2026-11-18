import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { copyText } from '@/lib/grid'

export type CellDialogState = { title: string; text: string; apply?: (text: string) => void }

/** Shows a full value, or edits a long one when apply is set. */
export function CellDialog({ state, onClose }: { state: CellDialogState; onClose: () => void }) {
  const [text, setText] = useState(state.text)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{state.title}</DialogTitle>
        </DialogHeader>
        {state.apply ? (
          <textarea
            autoFocus
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-[50vh] w-full resize-none rounded border bg-background p-2 font-mono text-xs"
          />
        ) : (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border p-2 font-mono text-xs">
            {state.text}
          </pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={async () => toast((await copyText(text)) ? 'Copied' : 'Copy failed')}>
            Copy
          </Button>
          {state.apply && (
            <Button
              onClick={() => {
                state.apply?.(text)
                onClose()
              }}
            >
              Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
