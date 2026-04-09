import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function Header({ onOpenSettings }) {
  return (
    <header className="flex items-center justify-between pb-4 mb-4 border-b">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Nebula</h1>
        <p className="text-xs text-muted-foreground">Valorant Account Manager</p>
      </div>
      <Button variant="ghost" size="icon" onClick={onOpenSettings}>
        <Settings className="h-4 w-4" />
      </Button>
    </header>
  )
}
