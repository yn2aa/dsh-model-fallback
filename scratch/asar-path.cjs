/**
 * Resolve where DeepSeek Harness's app.asar lives.
 *
 * The host publishes no env var for this, so probe the layouts a user can
 * actually end up with and use the first hit:
 *
 *   1. $ASAR                                explicit override
 *   2. <DSH_HOME>/../resources/app.asar      the app's own default home
 *   3. registry uninstall entries            the installer's InstallLocation
 *   4. start-menu shortcut target            works for portable installs too
 *
 * The registry and shortcut probes are what make this work for a relocated
 * install (D:\DeepSeek Harness instead of LOCALAPPDATA\Programs) without
 * hard-coding any one machine's paths.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REG_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
]

function candidates() {
  const list = []
  if (process.env.ASAR) list.push(process.env.ASAR)

  // The host's own default home sits next to the resources dir.
  if (process.env.DSH_HOME) {
    list.push(path.resolve(process.env.DSH_HOME, '..', 'resources', 'app.asar'))
  }
  if (process.env.USERPROFILE || process.env.HOME) {
    const home = process.env.USERPROFILE || process.env.HOME
    list.push(path.join(home, '.dsh', '..', 'resources', 'app.asar'))
  }

  // Whatever the installer registered, and whatever a shortcut points at.
  for (const extra of installRoots()) list.push(path.join(extra, 'resources', 'app.asar'))
  return list
}

function installRoots() {
  const roots = []
  if (process.platform !== 'win32') return roots
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      REG_KEYS.map((key) => `Get-ItemProperty '${key}' -ErrorAction SilentlyContinue`).join(';') +
      ' | Where-Object { $_.DisplayName -like "*DeepSeek Harness*" } | ForEach-Object { $_.InstallLocation; $_.DisplayIcon }'
    ], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^"|"$/g, '')
      if (!trimmed) continue
      // InstallLocation is a directory; DisplayIcon is often "<root>\app.exe,0".
      const root = trimmed.includes(',')
        ? path.dirname(trimmed.split(',')[0].replace(/^"|"$/g, ''))
        : trimmed.replace(/[\\/]+$/, '')
      if (root && path.isAbsolute(root)) roots.push(root)
    }
  } catch {
    // registry unreadable (constrained shell, non-Windows): fall through
  }

  try {
    const start = path.join(
      process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'
    )
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-ChildItem '${start}' -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |` +
      ' ForEach-Object { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName); if ($s.TargetPath -like "*DeepSeek Harness*") { $s.TargetPath } }'
    ], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) {
      const exe = line.trim()
      if (exe && path.isAbsolute(exe)) roots.push(path.dirname(exe))
    }
  } catch {
    // no start menu readable: fall through
  }

  return roots
}

/** Absolute path to app.asar, or null when none of the layouts matched. */
function findAsar() {
  for (const candidate of candidates()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not here, keep looking
    }
  }
  return null
}

/** Like findAsar() but throws a message naming every place it looked. */
function requireAsar() {
  const found = findAsar()
  if (found) return found
  throw new Error(
    'app.asar not found; set ASAR=<path>. Looked in:\n  ' + candidates().join('\n  ')
  )
}

module.exports = { candidates, installRoots, findAsar, requireAsar }
