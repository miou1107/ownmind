export type Item = {
  key: string
  /** task, bug and resolved are OwnMind's own: a task card, a report waiting on an admin, the user's report now resolved. */
  kind: 'assigned' | 'review' | 'failing' | 'comment' | 'task' | 'bug' | 'resolved'
  title: string
  url: string
  ref: string
  /** The project the card is grouped under: the repository's name, or a GitLab product label. */
  project: string
  /** Where the item lives, which picks the logo after the project's name. */
  source: 'github' | 'gitlab' | 'ownmind'
  /** When the item last changed (ISO time), for "N 天前" on the card; '' when unknown. */
  at: string
  /** Who the card names: the issue's opener, the PR's author or the last commenter, the user themself and bots included; '' when unknown. */
  person: string
  /** What tells one occurrence of the item from the next: the failing commit, or the time of the reply; '' for the rest. */
  mark: string
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
      /** Whether the pane opens by itself when a conversation starts with an item it has not shown before. */
      auto: boolean
    }
  }
}
