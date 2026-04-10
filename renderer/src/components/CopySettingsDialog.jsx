import { useState, useEffect } from 'react'
import { Copy, Monitor, ArrowRightLeft, ArrowDown } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'

export function CopySettingsDialog({ open, onOpenChange, targetAccount, accounts }) {
  const [sourceId, setSourceId] = useState('')
  const [copying, setCopying] = useState(false)
  const toast = useToast()

  useEffect(() => { if (open) setSourceId('') }, [open])

  const otherAccounts = accounts.filter(a => a.id !== targetAccount?.id)

  const handleCopyCloud = async () => {
    if (!sourceId) return toast.error('Select an account to copy from.')
    setCopying(true)
    try {
      const result = await window.electronAPI.copyCloudSettings(sourceId, targetAccount.id)
      if (result.success) {
        toast.success('All settings copied (crosshair, sens, keybinds). Restart Valorant to apply.')
        onOpenChange(false)
      } else toast.error(result.error)
    } catch (e) { toast.error(e.message) }
    finally { setCopying(false) }
  }

  const handleCopyVideo = async () => {
    if (!sourceId) return toast.error('Select an account to copy from.')
    setCopying(true)
    try {
      const result = await window.electronAPI.copySettings(sourceId, targetAccount.id)
      if (result.success) {
        toast.success(`Copied ${result.copied} video settings file(s).`)
        onOpenChange(false)
      } else toast.error(result.error)
    } catch (e) { toast.error(e.message) }
    finally { setCopying(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Copy Settings
          </DialogTitle>
          <DialogDescription>
            Copy settings to <strong>{targetAccount?.displayName || targetAccount?.username}</strong>{targetAccount?.nickname ? ` (${targetAccount.nickname})` : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
              Copy from
            </label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue placeholder="Select account..." />
              </SelectTrigger>
              <SelectContent>
                {otherAccounts.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.displayName || a.username}{a.nickname ? ` (${a.nickname})` : ''} · {a.region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Button onClick={handleCopyCloud} disabled={copying || !sourceId} className="w-full gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              {copying ? 'Copying...' : 'Copy All Settings'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Crosshair, sensitivity, keybinds. Both accounts need active sessions.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="space-y-2">
            <Button variant="outline" onClick={handleCopyVideo} disabled={copying || !sourceId} className="w-full gap-1.5">
              <Monitor className="h-3.5 w-3.5" />
              {copying ? 'Copying...' : 'Copy Video Settings Only'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Resolution, graphics, display. Works anytime.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
