import { useState, useEffect, useCallback } from 'react'
import { ThemeProvider } from '@/hooks/useTheme.jsx'
import { ToastProvider, useToast } from '@/components/ui/toast'
import { useAccounts } from '@/hooks/useAccounts'
import { useLaunchStatus } from '@/hooks/useLaunchStatus'
import { Header } from '@/components/Header'
import { AccountList } from '@/components/AccountList'
import { AddAccountSection } from '@/components/AddAccountSection'
import { SettingsDialog } from '@/components/SettingsDialog'
import { CopySettingsDialog } from '@/components/CopySettingsDialog'
import { NicknameDialog } from '@/components/NicknameDialog'
import { Footer } from '@/components/Footer'
import { CloseDialog } from '@/components/CloseDialog'

function AppContent() {
  const { accounts, loading, fetchAccounts, removeAccount, loginWithRiot, importAccount, launchValorant, setNickname, reorderAccounts, checkSession } = useAccounts()
  const { statuses, setStatus } = useLaunchStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [copyTarget, setCopyTarget] = useState(null)
  const [nicknameTarget, setNicknameTarget] = useState(null)
  const [appStatus, setAppStatus] = useState('Ready')
  const toast = useToast()

  useEffect(() => {
    fetchAccounts()
    window.electronAPI.getSettings().then(s => {
      if (!s.riotClientPath) {
        toast.error('Riot Client not found. Make sure Riot Games is installed.')
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

  return (
    <div className="h-screen overflow-hidden p-4 flex flex-col">
      <div className="w-full flex flex-col flex-1 min-h-0 animate-fade-in">
        <Header onOpenSettings={() => setSettingsOpen(true)} />

        <div className="space-y-4 flex-1 min-h-0 overflow-hidden">
          <AccountList
            accounts={accounts}
            loading={loading}
            statuses={statuses}
            onLaunch={handleLaunch}
            onRemove={handleRemove}
            onCopySettings={setCopyTarget}
            onSetNickname={setNicknameTarget}
            onCheckSession={checkSession}
            onReorder={handleReorder}
          />
          <AddAccountSection onLogin={handleLogin} onImport={handleImport} />
        </div>

        <Footer status={appStatus} />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
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
