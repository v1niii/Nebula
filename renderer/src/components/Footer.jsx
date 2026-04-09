export function Footer({ status }) {
  return (
    <footer className="mt-4 pt-3 border-t">
      <p className="text-xs text-muted-foreground truncate">{status || 'Ready'}</p>
    </footer>
  )
}
