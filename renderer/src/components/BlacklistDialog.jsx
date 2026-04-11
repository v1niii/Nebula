import { useState, useEffect, useCallback } from 'react'
import { Ban, Trash2, Users } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

function formatDate(ts) {
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ts))
  } catch { return '' }
}

// Read-only management view for the blacklist. Entries can only be added from
// the Match Info player stats dialog (where we have a real puuid), ensuring
// every blacklist entry is puuid-keyed and survives Riot ID changes.
export function BlacklistDialog({ open, onOpenChange, onChange }) {
  const [entries, setEntries] = useState({})
  const toast = useToast()

  const load = useCallback(async () => {
    try {
      const r = await window.electronAPI.getBlacklist()
      if (r.success) setEntries(r.blacklist || {})
    } catch (e) { toast.error(e.message) }
  }, [toast])

  useEffect(() => { if (open) load() }, [open, load])

  const handleRemove = async (puuid) => {
    try {
      await window.electronAPI.removeFromBlacklist(puuid)
      toast.success('Removed')
      await load()
      onChange && onChange()
    } catch (e) { toast.error(e.message) }
  }

  const entryList = Object.entries(entries).sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4" />
            Blacklist
          </DialogTitle>
          <DialogDescription>
            Players flagged here trigger a warning when they appear in your match.
            Add someone by clicking their row in Match Info and choosing "Add to blacklist".
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 pt-2">
          <div className="flex items-center gap-1.5 mb-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Blacklisted</h3>
            <span className="text-xs text-muted-foreground">({entryList.length})</span>
          </div>
          {entryList.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              No one's on your blacklist yet.
            </p>
          ) : (
            entryList.map(([puuid, entry]) => (
              <div key={puuid} className="flex items-start gap-2 rounded-md border bg-card/50 px-2.5 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{entry.name || 'Unknown'}</p>
                  {entry.reason && <p className="text-[11px] text-muted-foreground truncate italic">"{entry.reason}"</p>}
                  <p className="text-[10px] text-muted-foreground mt-0.5">Added {formatDate(entry.addedAt)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => handleRemove(puuid)}
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
