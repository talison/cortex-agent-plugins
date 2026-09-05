import { describe, expect, test } from 'bun:test'
import { PermissionRequests } from '../lib/permissions.ts'

const details = { tool_name: 'Bash', description: 'Run command', input_preview: '{}' }
const access = { dmPolicy: 'allowlist', allowFrom: ['1'] }
const pairedDM = { from: { id: 1 }, chat: { type: 'private' } }

function pending() {
  const requests = new PermissionRequests()
  requests.set('abcde', details)
  return requests
}

describe('permission replies (shared by text and buttons)', () => {
  test.each([
    ['unpaired DM', access, { from: { id: 999 }, chat: { type: 'private' } }],
    ['unpaired group member', access, { from: { id: 999 }, chat: { type: 'supergroup' } }],
    ['paired group member', access, { from: { id: 1 }, chat: { type: 'group' } }],
    ['disabled policy', { ...access, dmPolicy: 'disabled' }, pairedDM],
    ['unknown chat', access, { from: { id: 1 } }],
  ])('rejects %s', async (_name, policy, ctx) => {
    const requests = pending()
    let notified = false
    expect(await requests.reply('abcde', 'allow', policy, ctx, async () => { notified = true })).toBe(false)
    expect(notified).toBe(false)
    expect(requests.get('abcde')).toEqual(details)
  })

  test('requires an active request and consumes a successful reply once', async () => {
    const requests = pending()
    const sent: unknown[] = []
    const notify = async (params: unknown) => { sent.push(params) }
    expect(await requests.reply('zzzzz', 'allow', access, pairedDM, notify)).toBe(false)
    expect(await requests.reply('abcde', 'deny', access, pairedDM, notify)).toBe(true)
    expect(await requests.reply('abcde', 'allow', access, pairedDM, notify)).toBe(false)
    expect(sent).toEqual([{ request_id: 'abcde', behavior: 'deny' }])
  })

  test('a failed notification can be retried without claiming success', async () => {
    const requests = pending()
    await expect(requests.reply('abcde', 'allow', access, pairedDM, async () => {
      throw new Error('transport failed')
    })).rejects.toThrow('transport failed')
    expect(requests.get('abcde')).toEqual(details)
    expect(await requests.reply('abcde', 'allow', access, pairedDM, async () => {})).toBe(true)
  })

  test('concurrent text and button replies emit only one notification', async () => {
    const requests = pending()
    let release!: () => void
    const sent = requests.reply('abcde', 'allow', access, pairedDM, () => new Promise(resolve => { release = resolve }))
    expect(requests.get('abcde')).toBeUndefined()
    expect(await requests.reply('abcde', 'deny', access, pairedDM, async () => {
      throw new Error('duplicate notification')
    })).toBe(false)
    release()
    expect(await sent).toBe(true)
  })
})

test('ordinary phrases are unknown while pending and completed approval IDs stay known', async () => {
  const requests = pending()
  expect(requests.isKnown('maybe')).toBe(false)
  expect(requests.isKnown('abcde')).toBe(true)
  let release!: () => void
  const sending = requests.reply('abcde', 'allow', access, pairedDM, () => new Promise(resolve => { release = resolve }))
  expect(requests.isKnown('abcde')).toBe(true)
  release()
  await sending
  expect(requests.isKnown('abcde')).toBe(true)
  expect(await requests.reply('abcde', 'deny', access, pairedDM, async () => {})).toBe(false)
})
