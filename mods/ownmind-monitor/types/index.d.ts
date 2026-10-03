export type Activity = { id: string; time: string; label: string }

export type Health = {
  updateFailed: number
  judgeFailed: number
  server: 'ok' | 'down' | 'idle'
  behind: number
}

export type Week = {
  days: string[]
  sessions: number[]
  lookups: number[]
  violate: number[]
  comply: number[]
  updateFailed: number[]
}

export type View = {
  memory: { isLoaded: boolean; version: string }
  lookups: Activity[]
  saves: number
  blocks: Activity[]
  triggers: { total: number; byKind: Record<string, number> }
  health: Health
  week: Week
  warned: string
}

declare module 'claude-code' {
  interface PluginState {
    'ownmind-monitor': { view: View; times: Record<string, string> }
  }
}
