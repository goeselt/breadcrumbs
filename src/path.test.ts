import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandHome, toHomeRelative } from './path.js'

describe('path helpers', () => {
  it('expands home-prefixed paths', () => {
    expect(expandHome('~/breadcrumbs', '/tmp/home')).toBe(path.join('/tmp/home', 'breadcrumbs'))
    expect(expandHome('/var/tmp', '/tmp/home')).toBe('/var/tmp')
  })

  it('formats paths relative to home', () => {
    expect(toHomeRelative('/tmp/home/.codex/sessions', '/tmp/home')).toBe('~/.codex/sessions')
    expect(toHomeRelative('/other/place', '/tmp/home')).toBe('/other/place')
  })
})
