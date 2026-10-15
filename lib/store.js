/**
 * Plugin-local storage: the kill switch, the probe sink, and chain persistence.
 *
 * There is no log file to read in this installation, so probe/observability
 * output is written to a file under the plugin's own data directory. That also
 * gives us the emergency switch: a file the user can delete or edit to disable
 * interception without touching any code or restarting anything.
 *
 * Home resolution mirrors the harness helper the other installed plugins use:
 * `$DSH_HOME` else `~/.dsh`.
 *
 * @module dsh-model-fallback/store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Directory name under DSH home. */
export const DATA_DIR_NAME = 'model-fallback'

/** The kill switch file: while it holds `"off"`, interception is disabled. */
export const DISABLE_FILE = 'disable'

/** Where probe observations and failover records are appended. */
export const LOG_FILE = 'log.ndjson'

/** Where configured chains are persisted. */
export const CHAINS_FILE = 'chains.json'

/**
 * Resolve the harness home directory.
 *
 * @returns {string} the absolute DSH home path.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * Resolve this plugin's data directory and ensure it exists.
 *
 * @returns {string} the absolute directory path.
 */
export function dataDir() {
  const dir = path.join(resolveDshHome(), DATA_DIR_NAME)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // A read-only or missing home must not break the plugin: callers degrade.
  }
  return dir
}

/** Absolute path to the kill switch file. */
export function disablePath() {
  return path.join(dataDir(), DISABLE_FILE)
}

/** Absolute path to the observation log. */
export function logPath() {
  return path.join(dataDir(), LOG_FILE)
}

/** Absolute path to the persisted chains. */
export function chainsPath() {
  return path.join(dataDir(), CHAINS_FILE)
}

/**
 * Whether interception is currently disabled by the kill switch.
 *
 * Fails OPEN or CLOSED deliberately: if the file cannot be read at all we treat
 * the plugin as DISABLED. Doing nothing is always safe; guessing wrong in the
 * other direction can break every workspace.
 *
 * @returns {boolean} true when the user has switched the plugin off.
 */
export function isDisabled() {
  try {
    const raw = fs.readFileSync(disablePath(), 'utf8').trim().toLowerCase()
    return raw === 'off' || raw === '0' || raw === 'false'
  } catch (error) {
    // ENOENT (no switch file) means enabled — the normal case.
    return error?.code === 'ENOENT' ? false : true
  }
}

/**
 * Append one NDJSON record to the observation log.
 *
 * Never throws: an observability failure must not become a request failure.
 *
 * @param {string} kind - record kind, e.g. `probe` or `failover`.
 * @param {object} payload - the record body.
 * @returns {boolean} whether the write happened.
 */
export function appendLog(kind, payload) {
  try {
    const line = JSON.stringify({ t: Date.now(), kind, ...payload })
    fs.appendFileSync(logPath(), `${line}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Read the observation log, newest last.
 *
 * @param {number} [limit] - keep at most this many trailing records.
 * @returns {object[]} parsed records; malformed lines are skipped.
 */
export function readLog(limit = 200) {
  let raw
  try {
    raw = fs.readFileSync(logPath(), 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  const out = []
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn trailing write is expected; skip it.
    }
  }
  return out
}

/** Truncate the observation log. */
export function clearLog() {
  try {
    fs.writeFileSync(logPath(), '')
    return true
  } catch {
    return false
  }
}

/**
 * Load persisted chains.
 *
 * @returns {object[]} chain records, or an empty array when absent/unreadable.
 */
export function loadChains() {
  try {
    const parsed = JSON.parse(fs.readFileSync(chainsPath(), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Persist chains atomically enough for our purposes (write temp, then rename).
 *
 * @param {object[]} chains - the chain records to store.
 * @returns {boolean} whether the write succeeded.
 */
export function saveChains(chains) {
  const target = chainsPath()
  const tmp = `${target}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(chains, null, 2))
    fs.renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}
