/** One check's result. */
export type WrapupRow = {
  /** clean, dirty (something to clean up), judge (for the user to decide), running (still checking) */
  state: 'clean' | 'dirty' | 'judge' | 'running'
  /** The row's name, one of the six items of team standard 723. */
  name: string
  /** The one short line shown in the tile. */
  short: string
  /** The detail lines, one fact each. */
  lines: string[]
}

/** What the machine looked like when the session started; the residue check compares against it. */
export type WrapupBaseline = {
  containers: string[]
  ports: string[]
  worktrees: string[]
  /** When it was taken, in milliseconds; 0 until the snapshot has finished. */
  takenAt: number
}

export type WrapupReport = {
  /** When the checks ran, in milliseconds; 0 when they never did. */
  at: number
  rows: WrapupRow[]
}

/** A yellow row the model looked into and handled, reported through the resolve tool. */
export type WrapupResolution = {
  /** The row's name. */
  name: string
  /** One sentence, written by the model: what it did about the row. */
  done: string
  /** When the model reported it, in milliseconds. */
  at: number
  /** The row's detail lines when it was handled; a row that now says something else is yellow again. */
  seen: string
}

declare module 'claude-code' {
  interface PluginState {
    'wrapup-check': {
      baseline: WrapupBaseline
      report: WrapupReport
      /** Yellow rows handled since the user last typed a wrap-up word. */
      resolved: WrapupResolution[]
      /** How many test commands and background commands this session ran. */
      counts: { tests: number; background: number }
      /** The rows whose detail is expanded on the terminal (0 to 5). */
      openRows: number[]
    }
  }
}
