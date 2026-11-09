import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { DeviceRecord, Limit, SessionRecord, SyncStatus, Totals } from '../types'

const PANE = 'token-usage'
const STORE_KEY = 'sessions-v1'
const DEVICE_KEY = 'device-id'
const GIST_FILE = 'claude-token-usage.json'
const MAX_SESSIONS = 300
const SYNC_EVERY_MS = 60_000

const current = atom({ plugin: 'token-usage', key: 'current' } as const, null as SessionRecord | null, { shape: 'current-1' })
const sessions = atom({ plugin: 'token-usage', key: 'sessions' } as const, [] as SessionRecord[], { shape: 'sessions-1' })
const devices = atom({ plugin: 'token-usage', key: 'devices' } as const, [] as DeviceRecord[], { shape: 'devices-1' })
const limits = atom({ plugin: 'token-usage', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const sync = atom({ plugin: 'token-usage', key: 'sync' } as const, { state: 'off' } as SyncStatus, { shape: 'sync-1' })
// Which dropdowns are expanded in the pane.
const open = atom({ plugin: 'token-usage', key: 'open' } as const, ['devices'] as string[], { shape: 'open-1' })

// ---------- numbers ----------

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, usd: 0 })

const total = (t: Totals) => t.input + t.output + t.cacheRead + t.cacheWrite

const sum = (list: readonly Totals[]): Totals =>
  list.reduce(
    (a, b) => ({
      input: a.input + b.input,
      output: a.output + b.output,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheWrite: a.cacheWrite + b.cacheWrite,
      turns: a.turns + b.turns,
      usd: a.usd + b.usd,
    }),
    zero(),
  )

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
  : String(n)

const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: '7-day limit',
  spend_limit: 'Spend limit',
}

const bar = (pct: number) => {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

const isRecord = (v: unknown): v is SessionRecord =>
  typeof v === 'object' && v !== null && typeof (v as SessionRecord).id === 'string'

const isDevice = (v: unknown): v is DeviceRecord =>
  typeof v === 'object' && v !== null &&
  typeof (v as DeviceRecord).id === 'string' && typeof (v as DeviceRecord).name === 'string'

const str = (o: PluginOptions, k: string) => {
  const v = o[k]
  return typeof v === 'string' ? v.trim() : ''
}

// ---------- local records ----------

async function loadStored($: EngineInterface): Promise<SessionRecord[]> {
  const raw = await $.store.get(STORE_KEY)
  return Array.isArray(raw) ? raw.filter(isRecord) : []
}

async function deviceId($: EngineInterface): Promise<string> {
  const saved = await $.store.get(DEVICE_KEY)
  if (typeof saved === 'string' && saved) return saved
  const id = crypto.randomUUID()
  await $.store.set(DEVICE_KEY, id)
  return id
}

async function deviceName($: EngineInterface, options: PluginOptions): Promise<string> {
  return (
    str(options, 'device_name') ||
    (await $.env.get('HOSTNAME')) ||
    (await $.env.get('COMPUTERNAME')) ||
    'This device'
  )
}

// This device's totals: every conversation recorded here.
async function thisDevice($: EngineInterface, options: PluginOptions): Promise<DeviceRecord> {
  const cur = await read($, current)
  const all = await read($, sessions)
  const list = cur ? [...all.filter(s => s.id !== cur.id), cur] : all
  return {
    id: await deviceId($),
    name: await deviceName($, options),
    chats: list.length,
    lastActive: list.reduce((m, s) => Math.max(m, s.updatedAt), 0),
    ...sum(list),
  }
}

// Identify this conversation by when it began: stable across reloads and
// resumes, new after /clear.
async function ensureCurrent($: EngineInterface): Promise<SessionRecord> {
  const { startedAt } = await $.session.usage()
  const id = String(startedAt)
  const now = await read($, current)
  if (now && now.id === id) return now

  const stored = (await read($, sessions)).find(s => s.id === id)
  const fresh: SessionRecord = stored ?? {
    id,
    cwd: await $.session.cwd(),
    startedAt,
    updatedAt: startedAt,
    ...zero(),
  }
  await update($, current, () => fresh)
  return fresh
}

async function setStatus($: EngineInterface): Promise<void> {
  const cur = await read($, current)
  const all = await read($, sessions)
  const others = all.filter(s => s.id !== cur?.id)
  const overall = sum(cur ? [...others, cur] : others)
  const lim = (await read($, limits)).find(l => l.kind === 'five_hour')
  $.ui.status(
    `🪙 this chat ${fmt(cur ? total(cur) : 0)} · all ${fmt(total(overall))}` +
      (lim ? ` · 5h ${Math.round(lim.percentUsed)}%` : ''),
  )
}

async function saveLimits($: EngineInterface, list: readonly Limit[]): Promise<void> {
  if (list.length === 0) return
  await update($, limits, () =>
    list.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  )
}

// ---------- sync through a private GitHub Gist ----------

let lastSync = 0

async function syncDevices($: EngineInterface, options: PluginOptions, force = false): Promise<void> {
  const me = await thisDevice($, options)
  const gist = str(options, 'gist_id')
  const token = str(options, 'github_token')

  if (!gist || !token) {
    await update($, devices, () => [])
    await update($, sync, (): SyncStatus => ({ state: 'off' }))
    return
  }

  const now = await $.clock.now()
  if (!force && now - lastSync < SYNC_EVERY_MS) return
  lastSync = now

  const url = `https://api.github.com/gists/${encodeURIComponent(gist)}`
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'claude-code-token-usage-mod',
  }

  try {
    const got = await $.http.fetch(url, { headers })
    if (!got.ok) throw new Error(`GitHub answered ${got.status}`)
    const body = JSON.parse(got.text) as { files?: Record<string, { content?: string }> }
    let remote: DeviceRecord[] = []
    const content = body.files?.[GIST_FILE]?.content
    if (content) {
      const parsed = JSON.parse(content) as { devices?: unknown }
      if (Array.isArray(parsed.devices)) remote = parsed.devices.filter(isDevice)
    }
    const merged = [...remote.filter(d => d.id !== me.id), me]

    const put = await $.http.fetch(url, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: { [GIST_FILE]: { content: JSON.stringify({ devices: merged }, null, 2) } },
      }),
    })
    if (!put.ok) throw new Error(`GitHub refused the update (${put.status})`)

    await update($, devices, () => remote.filter(d => d.id !== me.id))
    await update($, sync, (): SyncStatus => ({ state: 'ok', at: now }))
  } catch (err) {
    await update($, sync, (): SyncStatus => ({
      state: 'error',
      at: now,
      message: err instanceof Error ? err.message : String(err),
    }))
  }
}

async function toggle($: EngineInterface, name: string): Promise<void> {
  await update($, open, list => (list.includes(name) ? list.filter(n => n !== name) : [...list, name]))
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'tokens',
      description: 'Show token usage: this conversation, overall, per device and account limits',
    })
    const stored = await loadStored($)
    await update($, sessions, () => stored)
    await ensureCurrent($)
    await saveLimits($, (await $.session.usage()).rateLimits)
    await setStatus($)
    void $.ui.open({ id: PANE, title: 'Token usage' })
    void syncDevices($, options, true).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Token usage' })
    await syncDevices($, options, true)
    const cur = await read($, current)
    const devs = [await thisDevice($, options), ...(await read($, devices))]
    const lines = [
      `This conversation: ${fmt(cur ? total(cur) : 0)} tokens (${usd(cur?.usd ?? 0)})`,
      ...devs.map(d => `${d.name}: ${fmt(total(d))} tokens (${usd(d.usd)}), ${d.chats} chats`),
      ...(await read($, limits)).map(
        l => `${LIMIT_NAMES[l.kind] ?? l.kind}: ${l.percentUsed}% used`,
      ),
    ]
    return { text: lines.join('\n') }
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) {
      await saveLimits($, e.rateLimits)
      await setStatus($)
    }
    return result
  })

  // Every model turn (main loop and subagents) reports its token usage here.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const u = e.usage
    if (!u) return result

    const base = await ensureCurrent($)
    const measured = await $.session.usage()
    const cost = measured.cost?.usd
    const rec: SessionRecord = {
      ...base,
      input: base.input + u.input_tokens,
      output: base.output + u.output_tokens,
      cacheRead: base.cacheRead + u.cache_read_input_tokens,
      cacheWrite: base.cacheWrite + u.cache_creation_input_tokens,
      turns: base.turns + (e.agentId ? 0 : 1),
      usd: typeof cost === 'number' ? cost : base.usd,
      updatedAt: await $.clock.now(),
    }
    await update($, current, () => rec)

    const list = [...(await read($, sessions)).filter(s => s.id !== rec.id), rec]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(-MAX_SESSIONS)
    await update($, sessions, () => list)
    await $.store.set(STORE_KEY, list)
    await saveLimits($, measured.rateLimits)
    await setStatus($)
    void syncDevices($, options).catch(() => undefined)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cur = await read($, current)
    const all = await read($, sessions)
    const me = await thisDevice($, options)
    const devs = [me, ...(await read($, devices))]
    const lims = await read($, limits)
    const st = await read($, sync)
    const expanded = await read($, open)
    const myId = me.id
    const others = all.filter(s => s.id !== cur?.id)
    const overall = sum(cur ? [...others, cur] : others)
    const recent = [...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
    const sortedDevs = [...devs].sort((a, b) => b.lastActive - a.lastActive)
    const allDevs = sum(devs)
    const isOpen = (n: string) => expanded.includes(n)

    const header = (name: string, label: string, hotkey: string) => (
      <Button key={`toggle-${name}`} hotkey={hotkey} plain onPress={() => toggle($, name)}>
        <Text bold>{isOpen(name) ? '▾' : '▸'} {label}</Text>
      </Button>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>This conversation</Text>
          <Text>
            Total: <Text bold color="cyan">{fmt(cur ? total(cur) : 0)}</Text> tokens · {usd(cur?.usd ?? 0)}
          </Text>
          <Text dimColor>
            in {fmt(cur?.input ?? 0)} · out {fmt(cur?.output ?? 0)} · cache read{' '}
            {fmt(cur?.cacheRead ?? 0)} · cache write {fmt(cur?.cacheWrite ?? 0)} · {cur?.turns ?? 0} turns
          </Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>This device, all conversations</Text>
          <Text>
            Total: <Text bold color="cyan">{fmt(total(overall))}</Text> tokens · {usd(overall.usd)}
          </Text>
          <Text dimColor>
            {others.length + (cur ? 1 : 0)} chats · {overall.turns} turns
          </Text>
        </Box>

        {header('limits', 'Account limits (all devices)', '1')}
        {isOpen('limits') && (
          <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
            {lims.length === 0 && (
              <Text dimColor>No reading yet (shown after the next reply, on a subscription plan).</Text>
            )}
            {lims.map(l => (
              <Text>
                {(LIMIT_NAMES[l.kind] ?? l.kind).padEnd(13)} {bar(l.percentUsed)} {l.percentUsed}%
                {l.resetsAt ? <Text dimColor> · resets {when(Date.parse(l.resetsAt))}</Text> : ''}
              </Text>
            ))}
          </Box>
        )}

        {header('devices', `Devices (${devs.length})`, '2')}
        {isOpen('devices') && (
          <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
            {sortedDevs.map(d => (
              <Box flexDirection="column">
                <Text>
                  <Text bold={d.id === myId}>{d.name}</Text>
                  {d.id === myId ? <Text color="green"> (this device)</Text> : ''} ·{' '}
                  <Text color="cyan">{fmt(total(d))}</Text> · {usd(d.usd)}
                </Text>
                <Text dimColor>
                  {d.chats} chats · {d.turns} turns · last active {d.lastActive ? when(d.lastActive) : '-'}
                </Text>
              </Box>
            ))}
            {devs.length > 1 && (
              <Text>
                All devices: <Text bold color="cyan">{fmt(total(allDevs))}</Text> · {usd(allDevs.usd)}
              </Text>
            )}
            {st.state === 'off' && (
              <Text dimColor>Sync is off: set a Gist ID and GitHub token in the mod's options to see other devices.</Text>
            )}
            {st.state === 'ok' && st.at !== undefined && <Text dimColor>Synced {when(st.at)}</Text>}
            {st.state === 'error' && <Text color="red">Sync failed: {st.message ?? 'unknown error'}</Text>}
          </Box>
        )}

        {header('recent', 'Recent conversations on this device', '3')}
        {isOpen('recent') && (
          <Box flexDirection="column" paddingLeft={2}>
            {recent.length === 0 && <Text dimColor>No earlier conversations yet.</Text>}
            {recent.map(s => (
              <Text dimColor>
                {when(s.startedAt)} · {fmt(total(s))} · {usd(s.usd)} · {s.cwd.split('/').pop() || s.cwd}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
