import { useState, useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/hooks/useTheme.jsx'
import { useToast } from '@/components/ui/toast'

export function SettingsDialog({ open, onOpenChange }) {
  const { theme, setTheme } = useTheme()
  const [path, setPath] = useState('')
  const [localTheme, setLocalTheme] = useState(theme)
  const [autoLaunch, setAutoLaunch] = useState(true)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (open) {
      window.electronAPI.getSettings().then(s => {
        setPath(s.valorantPath || '')
        setLocalTheme(s.theme || 'system')
        setAutoLaunch(s.autoLaunchValorant !== false)
      })
    }
  }, [open])

  const handleBrowse = async () => {
    const result = await window.electronAPI.selectValorantPath()
    if (result.success && result.path) {
      setPath(result.path)
    } else if (result.error) {
      toast.error(result.error)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    const result = await window.electronAPI.saveSettings({ valorantPath: path, theme: localTheme, autoLaunchValorant: autoLaunch })
    setSaving(false)
    if (result.success) {
      setTheme(localTheme)
      toast.success('Settings saved.')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure Nebula preferences.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Riot Games Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={path}
                placeholder="Not set"
                className="flex-1 h-9 px-3 rounded-md border bg-secondary/50 text-sm text-foreground truncate outline-none focus:ring-1 focus:ring-ring"
              />
              <Button variant="outline" size="sm" onClick={handleBrowse} className="gap-1.5 shrink-0">
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </Button>
            </div>
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
              <p className="text-xs text-muted-foreground">Start Valorant automatically when launching an account</p>
            </div>
            <Switch checked={autoLaunch} onCheckedChange={setAutoLaunch} />
          </div>

          <Button onClick={handleSave} disabled={saving} className="w-full">{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
