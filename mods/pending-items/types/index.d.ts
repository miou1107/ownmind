export type Item = {
  key: string
  kind: 'assigned' | 'review' | 'failing' | 'comment'
  title: string
  url: string
  ref: string
}

export type View = { items: Item[]; checkedAt: string; isLoaded: boolean }

declare module 'claude-code' {
  interface PluginState {
    'pending-items': { view: View }
  }
}
