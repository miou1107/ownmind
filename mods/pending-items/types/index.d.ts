export type Item = {
  key: string
  kind: 'assigned' | 'review' | 'failing' | 'comment'
  title: string
  url: string
  ref: string
  /** The project the card is grouped under: the repository's name, or a GitLab product label. */
  project: string
  /** Where the item lives, which picks the logo after the project's name. */
  source: 'github' | 'gitlab'
  /** When the item last changed (ISO time), for "N 天前" on the card; '' when unknown. */
  at: string
  /** Who is waiting on the user (the issue's opener, the PR's author, the last commenter); '' for nobody. */
  person: string
}

export type View = { items: Item[]; checkedAt: string; isLoaded: boolean }

declare module 'claude-code' {
  interface PluginState {
    'pending-items': {
      view: View
      /** The project the select shows; '' is every project. */
      filter: string
      /** Groups the person folded, by group key (source + project). */
      collapsed: string[]
      /** True while the refresh button's check runs. */
      busy: boolean
    }
  }
}
