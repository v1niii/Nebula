import { Settings, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'

const TAB_TITLES = {
  accounts: { title: 'Nebula', subtitle: 'Valorant Account Manager' },
  match:    { title: 'Match Info', subtitle: 'Pre-game & in-game details' },
  store:    { title: 'Store & Nightmarket', subtitle: 'Daily offers and bonus store' },
}

export function Header({ onOpenSettings, onOpenMenu, activeTab = 'accounts' }) {
  const meta = TAB_TITLES[activeTab] || TAB_TITLES.accounts
  return (
    <header className="flex items-center justify-between pb-4 mb-4 border-b">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onOpenMenu} aria-label="Open menu">
          <Menu className="h-4 w-4" />
        </Button>
        <div key={activeTab} className="animate-fade-in">
          <h1 className="text-xl font-semibold tracking-tight">{meta.title}</h1>
          <p className="text-xs text-muted-foreground">{meta.subtitle}</p>
        </div>
      </div>
      <Button variant="ghost" size="icon" onClick={onOpenSettings}>
        <Settings className="h-4 w-4" />
      </Button>
    </header>
  )
}
