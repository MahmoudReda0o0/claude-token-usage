import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'token-usage',
  component: 'Pane',
  requestId: 'token-usage',
  props: {
    title: 'Token usage',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const usage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
  model: 'claude',
}

const OLD = {
  id: 'old', cwd: '/x/blog', startedAt: 1, updatedAt: 2,
  input: 10000, output: 0, cacheRead: 0, cacheWrite: 0, turns: 3, usd: 1,
}

function engine(on: On) {
  mock.clock(on)
  mock.store(on, { 'sessions-v1': [OLD], 'device-id': 'dev-1' })
  on('ui.status', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: 1_700_000_000_000,
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 37, resetsAt: '2026-11-09T12:00:00Z' }],
      cost: { usd: 0.42 },
    },
  }))
  on('session.cwd', () => ({ value: '/home/user/shop' }))
  on('turn.complete', () => ({ text: 'ok' }))
}

async function twoTurns($: Engine) {
  await $.session.start({ cwd: '/home/user/shop', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 2; i++) {
    await $.turn.complete({
      reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false, turnId: `t${i}`, usage,
    })
  }
}

test('totals, devices and limits show in the pane', async ($, on) => {
  engine(on)
  await twoTurns($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const totals = await ui.findAll({ type: 'Text', text: /^Total:/ })
    expect(totals[0]?.text).toContain('7.0k')
    expect(totals[0]?.text).toContain('$0.42')
    expect(totals[1]?.text).toContain('17.0k')

    // Devices is open by default: this device, sync off (no options set).
    expect((await ui.find({ type: 'Text', text: /this device/ }))?.text).toContain('17.0k')
    expect(await ui.find({ type: 'Text', text: /Sync is off/ })).toBeTruthy()

    // Limits start closed; pressing the header opens the dropdown.
    expect(await ui.find({ type: 'Text', text: /37%/ })).toBeFalsy()
    await ui.press({ key: 'toggle-limits' })
    expect((await ui.find({ type: 'Text', text: /5-hour limit/ }))?.text).toContain('37%')
    await ui.press({ key: 'toggle-limits' })
    await ui.unmount()
  }
})

test('other devices come from the sync gist', { options: { gist_id: 'abc', github_token: 'x' } }, async ($, on) => {
  engine(on)
  const remote = {
    devices: [{
      id: 'dev-2', name: 'Office PC', chats: 4, lastActive: 5,
      input: 50000, output: 0, cacheRead: 0, cacheWrite: 0, turns: 9, usd: 2,
    }],
  }
  let written = ''
  on('http.fetch', (_, e) => {
    if (e.init?.method === 'PATCH') {
      written = e.init.body ?? ''
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    return {
      value: {
        status: 200, ok: true, headers: {},
        text: JSON.stringify({ files: { 'claude-token-usage.json': { content: JSON.stringify(remote) } } }),
      },
    }
  })
  await twoTurns($)
  await $.command.run({ command: 'tokens', args: '', origin: { kind: 'user' } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Office PC/ }))?.text).toContain('50.0k')
  expect((await ui.find({ type: 'Text', text: /^All devices/ }))?.text).toContain('67.0k')
  expect(written).toContain('Office PC')
  expect(written).toContain('dev-1')
  await ui.unmount()
})
