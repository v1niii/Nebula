import { useState, useEffect } from 'react'
import { Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'

export function CopySettingsDialog({ open, onOpenChange, targetAccount, accounts }) {
  const [sourceId, setSourceId] = useState('')
  const [copying, setCopying] = useState(false)
  const toast = useToast()

  // Reset selection when dialog opens for a different account
  useEffect(() => { if (open) setSourceId('') }, [open])

  const otherAccounts = accounts.filter(a => a.id !== targetAccount?.id)

  const handleCopy = async () => {
    if (!sourceId) {
      toast.error('Select an account to copy from.')
      return
    }
    setCopying(true)
    try {
      const result = await window.electronAPI.copySettings(sourceId, targetAccount.id)
      if (result.success) {
        toast.success(`Copied ${result.copied} settings file(s).`)
        onOpenChange(false)
      } else {
        toast.error(result.error)
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setCopying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Copy Settings</DialogTitle>
          <DialogDescription>
            Copy crosshair, keybinds, and video settings to <strong>{targetAccount?.displayName || targetAccount?.username}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Copy from</label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue placeholder="Select account..." />
              </SelectTrigger>
              <SelectContent>
                {otherAccounts.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.displayName || a.username} ({a.region})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs text-muted-foreground">
            Both accounts must have launched Valorant at least once for settings to exist.
          </p>

          <Button onClick={handleCopy} disabled={copying || !sourceId} className="w-full gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            {copying ? 'Copying...' : 'Copy Settings'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
