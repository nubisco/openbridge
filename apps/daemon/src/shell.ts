import os from 'os'

/**
 * The shell the terminal pane runs: the one the person would get at a login.
 *
 * `$SHELL` is set by a login, and a service manager does not log in. Under
 * OpenRC on the Pi the daemon has no `SHELL` at all, so the pane fell back to
 * busybox `sh` and the account's own shell (zsh, with its prompt and history)
 * never ran. The account's shell is in the password database, which
 * `os.userInfo()` reads, so that comes next. `/bin/sh` is the last resort.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userShell: () => string | null = () => os.userInfo().shell,
): string {
  if (platform === 'win32') return env.COMSPEC || 'cmd.exe'
  if (env.SHELL) return env.SHELL
  try {
    const shell = userShell()
    if (shell) return shell
  } catch {
    // No password entry for this uid (a bare container): fall through.
  }
  return '/bin/sh'
}
