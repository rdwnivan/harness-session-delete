/**
 * verify-live.mjs — post-deletion checker for the session-delete plugin.
 *
 * Checks the on-disk consequences of deleting one Session, including the
 * invariants that keep a Harness GUI able to open workspaces and create new
 * Sessions:
 *   1. the transcript directory is gone,
 *   2. the projection-cache row is gone,
 *   3. the workspace account no longer lists it (`sessionIds`),
 *   4. it is not left in `archivedSessionIds` — unless the deletion was recorded
 *      as leaving a tombstone, which is what hides the row of a Session the app
 *      still holds live (see `index.js`),
 *   5. it is not left in `pinnedSessionIds`,
 *   6. no membership dangles (an accounted id with no transcript),
 *   7. no Session id exists in two project directories (the startup brick:
 *      `sessionPersistence.list()` throws, the workspace registry never becomes
 *      active, and the GUI cannot open workspaces or create Sessions),
 *   8. the deletion audit line exists.
 *
 * Usage:
 *   node test/verify-live.mjs <session-id> [--home <dsh-home>]
 *   node test/verify-live.mjs --store [--home <dsh-home>]
 *
 * Exits 0 when every check passes, otherwise the number of failed checks. The
 * same logic is exported so `verify-live.selftest.mjs` can exercise it without
 * spawning a process.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = 'usage: node test/verify-live.mjs <session-id> [--home <dsh-home>] | --store [--home <dsh-home>]'

async function listDirectories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Every `<sessions>/<project>/<id>` directory that exists right now. */
export async function transcriptDirs(home, id) {
  const root = join(home, 'sessions')
  const found = []
  for (const project of await listDirectories(root)) {
    const candidate = join(root, project, id)
    if (await exists(candidate)) found.push(candidate)
  }
  return found
}

/** Every persisted per-record row for this id under the storage root. */
export async function projectionRows(home, id) {
  const root = join(home, 'storages')
  const found = []
  for (const unit of await listDirectories(root)) {
    for (const candidate of [join(root, unit, 'sessions', `${id}.json`), join(root, unit, `${id}.json`)]) {
      if (await exists(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * The last successful audit line the plugin wrote for one session.
 *
 * The deletion audit is the only record of what the plugin actually did, and it
 * is what tells this offline checker whether an entry left in
 * `archivedSessionIds` is the expected tombstone of a session the app still
 * holds live, or leftover bookkeeping.
 *
 * @param home - DSH home.
 * @param sessionId - session to look up.
 * @returns the parsed line, or undefined when no successful deletion was logged.
 */
export async function lastDeletion(home, sessionId) {
  let text = ''
  try {
    text = await readFile(join(home, 'session-delete', 'deletions.jsonl'), 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry
    try {
      entry = JSON.parse(lines[index])
    } catch {
      continue
    }
    if (entry?.sessionId === sessionId && entry?.ok === true) return entry
  }
  return undefined
}

/**
 * Check one DSH home.
 * @param options - `{ home, sessionId, storeOnly }`.
 * @returns `{ checks, info, failures }`.
 */
export async function verifyHome({ home, sessionId, storeOnly = false }) {
  const checks = []
  const info = []
  const check = (ok, label) => { checks.push({ ok: Boolean(ok), label }) }
  const failures = () => checks.filter((entry) => !entry.ok).length

  const workspaceFile = join(home, 'storages', 'workspace.json')
  check(await exists(workspaceFile), 'storages/workspace.json ada')
  if (!(await exists(workspaceFile))) return { checks, info, failures: failures() }

  const state = JSON.parse(await readFile(workspaceFile, 'utf8'))
  const workspaces = Object.entries(state?.tables?.workspaces ?? {})
  const archived = state?.global?.archivedSessionIds ?? []
  const pinned = state?.global?.pinnedSessionIds ?? []
  const deletion = storeOnly ? undefined : await lastDeletion(home, sessionId)
  // A session the app still holds live cannot leave `session.list`, so the
  // plugin leaves its archive entry as the tombstone that hides the row. That
  // entry is expected exactly when the recorded deletion says it was left.
  const tombstone = deletion?.tombstone === true

  if (!storeOnly) {
    const dirs = await transcriptDirs(home, sessionId)
    check(dirs.length === 0, `direktori transkrip terhapus (sisa: ${dirs.length})`)
    const rows = await projectionRows(home, sessionId)
    check(rows.length === 0, `baris cache proyeksi terhapus (sisa: ${rows.length})`)
    const owners = workspaces.filter(([, record]) => (record?.sessionIds ?? []).includes(sessionId)).map(([id]) => id)
    check(owners.length === 0, `keanggotaan workspace dilepas (pemilik tersisa: ${owners.length})`)
    check(
      archived.includes(sessionId) === tombstone,
      tombstone
        ? 'tertinggal di archivedSessionIds sebagai batu nisan sesi yang masih hidup (sesuai)'
        : 'tidak tertinggal di archivedSessionIds',
    )
    check(!pinned.includes(sessionId), 'tidak tertinggal di pinnedSessionIds')
  }

  const dangling = []
  for (const [, record] of workspaces) {
    for (const id of record?.sessionIds ?? []) {
      if ((await transcriptDirs(home, id)).length === 0) dangling.push(id)
    }
  }
  check(dangling.length === 0, `tidak ada keanggotaan menggantung (ditemukan: ${dangling.length})`)

  const root = join(home, 'sessions')
  const seen = new Map()
  for (const project of await listDirectories(root)) {
    for (const id of await listDirectories(join(root, project))) {
      seen.set(id, (seen.get(id) ?? 0) + 1)
    }
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1)
  check(duplicates.length === 0, `tidak ada id sesi duplikat antar direktori proyek (ditemukan: ${duplicates.length})`)

  if (!storeOnly) {
    const log = join(home, 'session-delete', 'deletions.jsonl')
    const audit = (await exists(log)) ? await readFile(log, 'utf8') : ''
    check(audit.includes(sessionId), 'baris audit penghapusan ada di session-delete/deletions.jsonl')
  }

  const accounted = workspaces.reduce((total, [, record]) => total + (record?.sessionIds ?? []).length, 0)
  info.push(`sesi tercatat: ${accounted} keanggotaan di ${workspaces.length} workspace`)
  info.push(`transkrip di disk: ${(await listDirectories(root)).length} direktori proyek, ${[...seen.values()].reduce((total, count) => total + count, 0)} sesi`)

  return { checks, info, failures: failures() }
}

/** Render one report as printable lines. */
export function renderReport({ checks, info, failures }) {
  return [
    ...checks.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}`),
    ...info.map((line) => `INFO  ${line}`),
    '---',
    failures === 0 ? 'SEMUA PEMERIKSAAN LOLOS' : `${failures} PEMERIKSAAN GAGAL`,
  ]
}

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME || join(homedir(), '.dsh'), sessionId: undefined, storeOnly: false, help: false, error: undefined }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--home') options.home = argv[++index]
    else if (argument === '--store') options.storeOnly = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (options.sessionId === undefined) options.sessionId = argument
    else options.error = `unexpected argument: ${argument}`
  }
  if (!options.help && options.error === undefined && options.sessionId === undefined && !options.storeOnly) options.error = USAGE
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.error !== undefined) {
    console.error(options.error)
    return 2
  }
  const report = await verifyHome(options)
  for (const line of renderReport(report)) console.log(line)
  return report.failures
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
