import { useCallback } from 'react'
import { Users } from 'lucide-react'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { AccountCard } from '@/components/AccountCard'

export function AccountList({ accounts, loading, statuses, onLaunch, onRemove, onCopySettings, onSetNickname, onCheckSession, onReorder }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event
    if (active.id !== over?.id) {
      const oldIndex = accounts.findIndex(a => a.id === active.id)
      const newIndex = accounts.findIndex(a => a.id === over.id)
      const reordered = arrayMove(accounts, oldIndex, newIndex)
      onReorder(reordered.map(a => a.id))
    }
  }, [accounts, onReorder])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Accounts</CardTitle>
          {accounts.length > 0 && <span className="text-xs text-muted-foreground ml-auto">{accounts.length}</span>}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Loading...</p>
        ) : accounts.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">No accounts yet</p>
            <p className="text-xs text-muted-foreground mt-1">Add one below to get started</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[400px]">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={accounts.map(a => a.id)} strategy={verticalListSortingStrategy}>
                {accounts.map((account, i) => (
                  <div key={account.id}>
                    {i > 0 && <Separator />}
                    <AccountCard
                      account={account}
                      launchStatus={(statuses[account.id] || {}).status || 'idle'}
                      onLaunch={onLaunch}
                      onRemove={onRemove}
                      onCopySettings={onCopySettings}
                      onSetNickname={onSetNickname}
                      onCheckSession={onCheckSession}
                    />
                  </div>
                ))}
              </SortableContext>
            </DndContext>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
