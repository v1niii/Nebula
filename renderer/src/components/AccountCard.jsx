import { memo, useState } from 'react'
import { Play, Trash2, Copy, Tag, GripVertical, ShieldCheck, ShieldAlert, Loader2, RefreshCw } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { StatusIndicator } from '@/components/StatusIndicator'
import { useToast } from '@/components/ui/toast'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

function formatTime(ts) {
  if (!ts) return 'Never'
  try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ts)) } catch { return 'Unknown' }
}

export const AccountCard = memo(function AccountCard({ account, launchStatus, onLaunch, onRemove, onCopySettings, onSetNickname, onCheckSession }) {
  const [sessionState, setSessionState] = useState(null)
  const toast = useToast()
  const isLaunching = launchStatus === 'launching'
  const isRunning = launchStatus === 'running'
  const isExpired = sessionState === 'expired'
  const disabled = isLaunching || isRunning || isExpired

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  const displayName = account.nickname || account.displayName || account.username
  const fullName = account.displayName || account.username || ''

  const handleCheckSession = async () => {
    setSessionState('checking')
    try {
      const result = await onCheckSession(account.id)
      if (result.valid) {
        setSessionState('valid')
        toast.success(`Session active for ${displayName}`)
        setTimeout(() => setSessionState(null), 8000)
      } else {
        setSessionState('expired')
        toast.error(`${displayName}: Session expired. Re-login required.`)
      }
    } catch (e) {
      setSessionState('expired')
      toast.error(`${displayName}: Failed to check session.`)
    }
  }

  const handleLaunch = (id) => {
    if (isExpired) {
      toast.error(`${displayName}: Session expired. Remove and re-add the account.`)
      return
    }
    onLaunch(id)
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 py-3 px-1 group animate-fade-in">
      <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition-colors shrink-0">
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="flex-1 min-w-0 mr-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate" title={fullName}>
            {displayName}
          </p>
          {account.nickname && (
            <span className="text-xs text-muted-foreground truncate hidden sm:inline" title={fullName}>
              {fullName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 h-4">
          <span className="text-xs text-muted-foreground">{account.region || 'N/A'}</span>
          <span className="text-xs text-muted-foreground">{formatTime(account.lastUsed)}</span>
          <StatusIndicator status={launchStatus} />
        </div>
      </div>

      <div className="flex items-center gap-1">
        {/* Session health - retry allowed even when expired */}
        <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity" onClick={handleCheckSession} disabled={sessionState === 'checking'} title="Check session health">
          {sessionState === 'checking' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> :
           sessionState === 'valid' ? <ShieldCheck className="h-3.5 w-3.5 text-purple-500" /> :
           sessionState === 'expired' ? <RefreshCw className="h-3.5 w-3.5 text-destructive" /> :
           <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />}
        </Button>

        <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground" onClick={() => onSetNickname(account)} title="Set nickname">
          <Tag className="h-3.5 w-3.5" />
        </Button>

        <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground" onClick={() => onCopySettings(account)} title="Copy settings to this account">
          <Copy className="h-3.5 w-3.5" />
        </Button>

        <Button size="sm" onClick={() => handleLaunch(account.id)} disabled={disabled} className={`gap-1.5 ${isExpired ? 'opacity-50' : ''}`}>
          {isExpired ? <ShieldAlert className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {isExpired ? 'Expired' : isLaunching ? 'Launching' : isRunning ? 'Running' : 'Launch'}
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Account</AlertDialogTitle>
              <AlertDialogDescription>Remove "{displayName}" from Nebula?</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onRemove(account.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
})
