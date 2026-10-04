export type Activity = { id: string; time: string; label: string }

export type Health = {
  updateFailed: number
  judgeFailed: number
  server: 'ok' | 'down' | 'idle'
  behind: number
  // True when one of today's update attempts failed at the fetch step, so the machine
  // could not reach the update server and `behind` says nothing.
  unreachable: boolean
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
