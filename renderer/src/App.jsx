import { useState, useEffect, useCallback } from 'react'
import { ThemeProvider } from '@/hooks/useTheme.jsx'
import { ToastProvider, useToast } from '@/components/ui/toast'
import { useAccounts } from '@/hooks/useAccounts'
import { useLaunchStatus } from '@/hooks/useLaunchStatus'
import { Header } from '@/components/Header'
import { SideMenu } from '@/components/SideMenu'
import { AccountList } from '@/components/AccountList'
import { AddAccountSection } from '@/components/AddAccountSection'
import { SettingsDialog } from '@/components/SettingsDialog'
import { CopySettingsDialog } from '@/components/CopySettingsDialog'
import { NicknameDialog } from '@/components/NicknameDialog'
import { Footer } from '@/components/Footer'
import { CloseDialog } from '@/components/CloseDialog'
import { StoreTab } from '@/components/StoreTab'
import { MatchInfoTab } from '@/components/MatchInfoTab'

function AppContent() {
  const { accounts, loading, fetchAccounts, removeAccount, loginWithRiot, importAccount, launchValorant, setNickname, reorderAccounts, checkSession } = useAccounts()
  const { statuses, setStatus } = useLaunchStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('accounts')
  const [features, setFeatures] = useState({ store: false, matchInfo: false })
  const [accountRanks, setAccountRanks] = useState({}) // accountId → { current, peak }
  const [accountSessions, setAccountSessions] = useState({}) // accountId → today's stats
  const [copyTarget, setCopyTarget] = useState(null)
  const [nicknameTarget, setNicknameTarget] = useState(null)
  const [appStatus, setAppStatus] = useState('Ready')
  const toast = useToast()

  // Refresh feature flags — called on mount and after saving settings so the
  // hamburger menu and active tab react to the toggles immediately.
  const refreshFeatures = useCallback(async () => {
    const s = await window.electronAPI.getSettings()
    setFeatures({ store: !!s.enableStoreFeature, matchInfo: !!s.enableMatchInfoFeature })
    return s
  }, [])

  useEffect(() => {
    fetchAccounts()
    refreshFeatures().then(s => {
      if (!s.riotClientPath) {
        toast.error('Riot Client not found. Make sure Riot Games is installed.')
      }
    })

    // Auto-updater notifications
    window.electronAPI.onUpdateStatus?.((info) => {
      if (info.type === 'available') {
        toast.info(`Update available: v${info.version}. Downloading...`)
      } else if (info.type === 'downloaded') {
        toast.success(`Update v${info.version} ready. Restart to install.`, {
          duration: 0,
          action: { label: 'Restart now', onClick: () => window.electronAPI.installUpdateNow() },
        })
      }
    })
  }, [fetchAccounts]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = useCallback(async () => {
    setAppStatus('Waiting for Riot login...')
    const result = await loginWithRiot()
    setAppStatus('Ready')
    return result
  }, [loginWithRiot])

  const handleImport = useCallback(async () => {
    setAppStatus('Importing...')
    const result = await importAccount()
    setAppStatus('Ready')
    return result
  }, [importAccount])

  // Reset footer when launch status changes
  useEffect(() => {
    const vals = Object.values(statuses)
    const anyLaunching = vals.some(s => s.status === 'launching')
    const anyRunning = vals.some(s => s.status === 'running')
    if (anyRunning) setAppStatus('Valorant running')
    else if (!anyLaunching && (appStatus === 'Launching...' || appStatus === 'Valorant running')) setAppStatus('Ready')
  }, [statuses, appStatus])

  const handleLaunch = useCallback(async (accountId) => {
    setStatus(accountId, 'launching')
    setAppStatus('Launching...')
    const result = await launchValorant(accountId)
    if (!result.success) {
      setStatus(accountId, 'error', result.error)
      toast.error(result.error || 'Launch failed.')
      setAppStatus('Ready')
    }
  }, [launchValorant, setStatus, toast])

  const handleRemove = useCallback(async (accountId) => {
    const result = await removeAccount(accountId)
    if (result.success) toast.success('Account removed.')
  }, [removeAccount, toast])

  const handleSetNickname = useCallback(async (accountId, nickname) => {
    const result = await setNickname(accountId, nickname)
    if (result.success) toast.success('Nickname updated.')
  }, [setNickname, toast])

  const handleReorder = useCallback(async (orderedIds) => {
    await reorderAccounts(orderedIds)
  }, [reorderAccounts])

  // If the currently-active tab gets disabled in settings, snap back to accounts.
  useEffect(() => {
    if (activeTab === 'store' && !features.store) setActiveTab('accounts')
    if (activeTab === 'match' && !features.matchInfo) setActiveTab('accounts')
  }, [features, activeTab])

  // Fetch rank badges + session stats for every account in PARALLEL across
  // accounts (each account's rank+session pair still runs sequentially to
  // be polite to that one account's MMR endpoint, but accounts don't wait
  // for each other). With 3 accounts this drops cold-start UI time from
  // ~12s sequential → ~4s. Cached in component state so tab switches never
  // re-fetch. Silently skips accounts that fail (expired session, etc.).
  useEffect(() => {
    if (!accounts.length) { setAccountRanks({}); setAccountSessions({}); return }
    let cancelled = false
    const fetchOne = async (acc) => {
      if (cancelled) return
      if (!accountRanks[acc.id]) {
        try {
          const r = await window.electronAPI.getAccountRank(acc.id)
          if (cancelled) return
          if (r.success && r.rank) setAccountRanks(prev => ({ ...prev, [acc.id]: r.rank }))
        } catch { /* silent */ }
      }
      if (cancelled) return
      if (!accountSessions[acc.id]) {
        try {
          const s = await window.electronAPI.getSessionStats(acc.id)
          if (cancelled) return
          if (s.success && s.session) setAccountSessions(prev => ({ ...prev, [acc.id]: s.session }))
        } catch { /* silent */ }
      }
    }
    Promise.all(accounts.map(fetchOne)).catch(() => {})
    return () => { cancelled = true }
  }, [accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-screen overflow-hidden p-4 flex flex-col">
      <div className="w-full flex flex-col flex-1 min-h-0 animate-fade-in">
        <Header
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenMenu={() => setMenuOpen(true)}
          activeTab={activeTab}
        />

        {/* key on activeTab remounts children so the fade-in replays on every tab switch */}
        <div key={activeTab} className="flex-1 min-h-0 flex flex-col gap-4 animate-fade-in">
          {activeTab === 'accounts' && (
            <>
              <div className="flex-1 min-h-0">
                <AccountList
                  accounts={accounts}
                  loading={loading}
                  statuses={statuses}
                  ranks={accountRanks}
                  sessions={accountSessions}
                  onLaunch={handleLaunch}
                  onRemove={handleRemove}
                  onCopySettings={setCopyTarget}
                  onSetNickname={setNicknameTarget}
                  onCheckSession={checkSession}
                  onReorder={handleReorder}
                />
              </div>
              <div className="shrink-0">
                <AddAccountSection onLogin={handleLogin} onImport={handleImport} />
              </div>
            </>
          )}
          {activeTab === 'store' && features.store && <StoreTab accounts={accounts} />}
          {activeTab === 'match' && features.matchInfo && <MatchInfoTab accounts={accounts} />}
        </div>

        <Footer status={appStatus} />
        <SideMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          features={features}
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onSaved={refreshFeatures} />
        <CopySettingsDialog open={!!copyTarget} onOpenChange={(o) => { if (!o) setCopyTarget(null) }} targetAccount={copyTarget} accounts={accounts} />
        <NicknameDialog open={!!nicknameTarget} onOpenChange={(o) => { if (!o) setNicknameTarget(null) }} account={nicknameTarget} onSave={handleSetNickname} />
        <CloseDialog />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ThemeProvider>
  )
}
