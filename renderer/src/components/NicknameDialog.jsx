import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function NicknameDialog({ open, onOpenChange, account, onSave }) {
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) setValue(account?.nickname || '')
  }, [open, account])

  const handleSave = () => {
    onSave(account.id, value.trim())
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set Nickname</DialogTitle>
          <DialogDescription>Label for {account?.displayName || account?.username}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Main, Smurf, Alt..."
            maxLength={30}
            className="w-full h-9 px-3 rounded-md border bg-secondary/50 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            autoFocus
          />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">Cancel</Button>
            <Button onClick={handleSave} className="flex-1">Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
