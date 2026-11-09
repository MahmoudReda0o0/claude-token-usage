export type Totals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
  usd: number
}

export type SessionRecord = Totals & {
  id: string
  cwd: string
  startedAt: number
  updatedAt: number
}

export type DeviceRecord = Totals & {
  id: string
  name: string
  chats: number
  lastActive: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type SyncStatus = { state: 'off' | 'ok' | 'error'; at?: number; message?: string }

declare module 'claude-code' {
  interface PluginState {
    'token-usage': {
      current: Shaped<SessionRecord | null>
      sessions: Shaped<SessionRecord[]>
      devices: Shaped<DeviceRecord[]>
      limits: Shaped<Limit[]>
      sync: Shaped<SyncStatus>
      open: Shaped<string[]>
    }
  }
}
