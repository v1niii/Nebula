import { useState, useEffect } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/hooks/useTheme.jsx'
import { useToast } from '@/components/ui/toast'

export function SettingsDialog({ open, onOpenChange }) {
  const { theme, setTheme } = useTheme()
  const [riotClientPath, setRiotClientPath] = useState('')
  const [localTheme, setLocalTheme] = useState(theme)
  const [autoLaunch, setAutoLaunch] = useState(true)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (open) {
      window.electronAPI.getSettings().then(s => {
        setRiotClientPath(s.riotClientPath || '')
        setLocalTheme(s.theme || 'system')
        setAutoLaunch(s.autoLaunchValorant !== false)
      })
    }
  }, [open])

  const handleSave = async () => {
    setSaving(true)
    const result = await window.electronAPI.saveSettings({ theme: localTheme, autoLaunchValorant: autoLaunch })
    setSaving(false)
    if (result.success) {
      setTheme(localTheme)
      toast.success('Settings saved.')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure Nebula preferences.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Riot Client</label>
            <div className="flex items-center gap-2 h-9 px-3 rounded-md border bg-secondary/50 text-sm overflow-hidden">
              {riotClientPath ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  <span className="text-foreground truncate text-xs">{riotClientPath}</span>
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  <span className="text-muted-foreground">Not detected. Install Riot Games.</span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Auto-detected from Riot Games installation.</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <label className="text-sm font-medium">Theme</label>
            <Select value={localTheme} onValueChange={setLocalTheme}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">Auto-Launch Valorant</label>
              <p className="text-xs text-muted-foreground">Start Valorant automatically when launching an account.</p>
            </div>
            <Switch checked={autoLaunch} onCheckedChange={setAutoLaunch} />
          </div>

          <Button onClick={handleSave} disabled={saving} className="w-full">{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
