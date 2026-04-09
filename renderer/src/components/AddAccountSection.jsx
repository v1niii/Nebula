import { useState } from 'react'
import { LogIn, Download } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/toast'

export function AddAccountSection({ onLogin, onImport }) {
  const [loginLoading, setLoginLoading] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const toast = useToast()

  const handleLogin = async () => {
    setLoginLoading(true)
    try {
      const result = await onLogin()
      if (result?.success) {
        toast.success(`${result.account?.displayName || result.account?.username || 'Account'} added (${result.account?.region}).`)
      } else if (result?.error) {
        toast.error(result.error)
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoginLoading(false)
    }
  }

  const handleImport = async () => {
    setImportLoading(true)
    try {
      const result = await onImport()
      if (result?.success) {
        toast.success(`${result.account?.displayName || result.account?.username || 'Account'} imported.`)
      } else if (result?.error) {
        toast.error(result.error)
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setImportLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Add Account</CardTitle>
        <CardDescription>Sign in with your Riot account or import an active session.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={handleLogin} disabled={loginLoading} className="w-full gap-1.5">
          <LogIn className="h-3.5 w-3.5" />
          {loginLoading ? 'Opening...' : 'Login with Riot'}
        </Button>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">or</span>
          <Separator className="flex-1" />
        </div>

        <Button variant="outline" onClick={handleImport} disabled={importLoading} className="w-full gap-1.5">
          <Download className="h-3.5 w-3.5" />
          {importLoading ? 'Importing...' : 'Import from Riot Client'}
        </Button>
      </CardContent>
    </Card>
  )
}
