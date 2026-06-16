import { describe, expect, it } from 'vitest'
import { resolveSettingState } from './settings.js'

describe('restricted configuration resolution', () => {
  it('ignores a workspace-selected path in Restricted Mode', () => {
    expect(
      resolveSettingState(
        'github.copilot.chat.otel.outfile',
        '/workspace/secret',
        {
          globalValue: '/home/user/copilot.jsonl',
          workspaceValue: '/workspace/secret',
        },
        false,
      ),
    ).toMatchObject({
      value: '/home/user/copilot.jsonl',
      configured: true,
      ignoredInRestrictedMode: true,
    })
  })

  it('uses the effective workspace value in a trusted workspace', () => {
    expect(
      resolveSettingState(
        'github.copilot.chat.otel.outfile',
        '/workspace/copilot.jsonl',
        {
          globalValue: '/home/user/copilot.jsonl',
          workspaceValue: '/workspace/copilot.jsonl',
        },
        true,
      ),
    ).toMatchObject({
      value: '/workspace/copilot.jsonl',
      ignoredInRestrictedMode: false,
    })
  })
})
