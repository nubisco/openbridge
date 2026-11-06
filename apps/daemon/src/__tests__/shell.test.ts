import { describe, it, expect } from 'vitest'
import { resolveShell } from '../shell.js'

describe('resolveShell', () => {
  it('uses $SHELL when the daemon was started from a login', () => {
    expect(resolveShell({ SHELL: '/bin/bash' }, 'linux', () => '/bin/zsh')).toBe('/bin/bash')
  })

  it("uses the account's shell when a service manager left $SHELL unset", () => {
    // OpenRC on the Pi: no SHELL in the environment, zsh in /etc/passwd.
    expect(resolveShell({}, 'linux', () => '/bin/zsh')).toBe('/bin/zsh')
  })

  it('falls back to /bin/sh when the account has no shell or no entry', () => {
    expect(resolveShell({}, 'linux', () => null)).toBe('/bin/sh')
    expect(
      resolveShell({}, 'linux', () => {
        throw new Error('no passwd entry')
      }),
    ).toBe('/bin/sh')
  })

  it('uses the command interpreter on Windows', () => {
    expect(resolveShell({ COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }, 'win32')).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(resolveShell({}, 'win32')).toBe('cmd.exe')
  })
})
