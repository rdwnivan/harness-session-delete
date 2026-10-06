/**
 * Host half of the local `session-delete` bundle.
 *
 * Deletes a persisted session the way the Harness itself expects: admission
 * through the workspace registry, durable bookkeeping through the domain store
 * (never by editing `workspace.json`), and only then the transcript directory
 * and the projection-cache row on disk.
 *
 * Ordering is deliberate and is what keeps the app healthy:
 *   1. refuse a session whose work is running (the registry's own archive gate),
 *   2. remove the transcript bytes first, so a locked file changes nothing,
 *   3. detach the workspace accounting, then clear the global archive/pin sets,
 *   4. drop projection rows and tell every open page the session is gone.
 *
 * If step 2 fails, step 3 never runs and the archived state is rolled back, so a
 * refused deletion leaves the store exactly as it was.
 *
 * This module imports nothing but Node builtins on purpose: a profile-installed
 * bundle must not depend on how the launcher anchors `@deepseek-ai/*` resolution.
 * It also writes two small files under `<DSH_HOME>/session-delete/` — an
 * activation receipt and an append-only deletion log — so that "did the plugin
 * load?" and "what did it delete?" are answerable without a browser.
 */
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Exact Connection-fenced route the browser half calls. */
const ROUTE_PATH = '/api/session-delete.delete'

/** Second route: the browser half's own receipt, so a headless check can prove the UI loaded. */
const HELLO_PATH = '/api/session-delete.hello'

/**
 * Session ids the Harness mints: `session-<uuid>` for user Sessions and a bare
 * `<uuid>` for subagent Sessions. Both are identity-encoded as the on-disk
 * directory segment, and both exclude path separators by construction.
 */
const SESSION_ID = /^(?:session-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Bumped when the deletion sequence changes; recorded in the receipts. */
const VERSION = '1.0.0'

/** This package's name: the browser module id and the boot-graph row id. */
const PACKAGE_NAME = 'harness-session-delete'

export const name = 'session-delete'
export const inject = ['connection', 'sessions', 'sessionPersistence', 'workspaceRegistry']

/**
 * Register the delete endpoint for the lifetime of this plugin.
 * @param ctx - Cordis context carrying Connection, Session, persistence, and registry services.
 */
export function apply(ctx) {
  const registered = []

  /**
   * Register one route without letting a duplicate path abort the plugin. A
   * re-mount can overlap the instance it replaces, and a row that fails to
   * activate takes the whole feature down with it — so a collision is reported
   * in `errors.jsonl` instead of thrown.
   */
  const register = (route, label) => {
    try {
      const dispose = ctx.connection.fetch.register(route)
      registered.push(route.path)
      return dispose
    } catch (error) {
      void record('errors.jsonl', {
        at: new Date().toISOString(),
        version: VERSION,
        event: 'route-registration-failed',
        route: route.path,
        label,
        message: String(error?.message ?? error),
      })
      return undefined
    }
  }

  ctx.effect(() => register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleDelete(ctx, request),
  }, 'delete route'), `session-delete: ${ROUTE_PATH}`)

  ctx.effect(() => register({
    path: HELLO_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleHello(request),
  }, 'browser receipt route'), `session-delete: ${HELLO_PATH}`)

  void record('status.json', {
    at: new Date().toISOString(),
    version: VERSION,
    route: ROUTE_PATH,
    hello: HELLO_PATH,
    registered,
    home: resolveHome(),
  })

  // Diagnostic receipt only: prove from the Host side that this package's browser
  // half was published to the page's boot graph. Optional service, so a profile
  // without the Web client composition simply never writes it.
  ctx.inject(['clientModules'], (modulesCtx) => {
    const modules = modulesCtx.clientModules
    let last = ''
    const snapshot = () => {
      try {
        const graph = modules.graph()
        const entries = Array.isArray(graph?.entries) ? graph.entries : []
        const mine = entries.find((entry) => entry?.id === PACKAGE_NAME) ?? null
        const clientPath = (() => {
          try {
            return modules.clientPath(PACKAGE_NAME)
          } catch {
            return undefined
          }
        })()
        const value = {
          at: new Date().toISOString(),
          version: VERSION,
          graphRev: graph?.rev,
          entryCount: entries.length,
          published: mine !== null,
          entry: mine,
          clientPath,
        }
        const encoded = JSON.stringify({ published: value.published, rev: value.entry?.rev, entries: value.entryCount })
        if (encoded === last) return
        last = encoded
        void record('client-graph.json', value)
      } catch (error) {
        void record('client-graph.json', { at: new Date().toISOString(), version: VERSION, error: String(error?.message ?? error) })
      }
    }
    snapshot()
    const timer = setTimeout(snapshot, 3000)
    modulesCtx.effect(() => () => clearTimeout(timer))
    if (typeof modules.onGraphChanged === 'function') {
      const dispose = modules.onGraphChanged(snapshot)
      modulesCtx.effect(() => () => {
        if (typeof dispose === 'function') dispose()
      })
    }
  })
}

/** Record that the browser half reached the page; never fails the page. */
async function handleHello(request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    payload = {}
  }
  const report = {
    at: new Date().toISOString(),
    version: VERSION,
    event: typeof payload?.event === 'string' ? payload.event.slice(0, 40) : 'unknown',
    path: typeof payload?.path === 'string' ? payload.path.slice(0, 80) : undefined,
    locale: typeof payload?.locale === 'string' ? payload.locale.slice(0, 24) : undefined,
  }
  await record('client.jsonl', report)
  return json({ ok: true, ...report })
}

// ---------------------------------------------------------------------------
// Route handling
// ---------------------------------------------------------------------------

async function handleDelete(ctx, request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return refuse('invalid-body', 'Expected a JSON body with a sessionId.', 400, undefined)
  }

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
  if (sessionId === undefined || !SESSION_ID.test(sessionId)) {
    return refuse('invalid-session-id', 'A session id shaped like "session-<uuid>" or "<uuid>" is required.', 400, sessionId)
  }

  try {
    const report = await deleteSession(ctx, sessionId)
    void record('deletions.jsonl', { at: new Date().toISOString(), version: VERSION, ...report })
    return json(report)
  } catch (error) {
    const refusal = refusalOf(error)
    const message = error instanceof Error ? error.message : String(error)
    return refuse(refusal?.body?.code ?? 'failed', message, refusal?.status ?? 500, sessionId, refusal?.body)
  }
}

/**
 * Answer with a refusal and leave the same audit line a success leaves, so every
 * request that reaches the plugin is answerable from `<home>/session-delete/`.
 */
function refuse(code, message, status, sessionId, extra) {
  void record('deletions.jsonl', {
    at: new Date().toISOString(),
    version: VERSION,
    sessionId,
    ok: false,
    code,
    message,
    ...(extra === undefined ? {} : { detail: extra }),
  })
  return json({ code, message, ...(extra === undefined ? {} : extra) }, status)
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Delete one persisted session.
 * @param ctx - Cordis context.
 * @param sessionId - The session to remove.
 * @returns A report of everything that was removed.
 */
async function deleteSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const warnings = []

  const stored = await readStoredHeader(ctx, sessionId)
  const owner = owningWorkspace(registry, sessionId)
  const live = ctx.sessions.get(sessionId) !== undefined

  if (stored === undefined && owner === undefined) {
    const missing = new Error(`session "${sessionId}" is not stored and no workspace accounts for it`)
    missing.code = 'session/not-found'
    throw missing
  }

  // A Session another Session was forked or spawned from is part of a lineage:
  // deleting it out from under a visible child is the caller's decision to make
  // first, so a forked child refuses the deletion. Subagent children are hidden
  // from the sidebar, so they are reported instead of blocking the parent.
  const children = await childrenOf(ctx, sessionId)
  if (children.blocking.length > 0) {
    const error = new Error(
      `session "${sessionId}" still has forked session${children.blocking.length === 1 ? '' : 's'} `
      + `${children.blocking.join(', ')}; delete ${children.blocking.length === 1 ? 'it' : 'them'} first`,
    )
    error.code = 'session/has-children'
    error.children = children.blocking
    throw error
  }

  // Admission first: the registry's archive check is the shipped answer to
  // "what still runs for this session" and refuses a session whose own turn, a
  // subagent, a job, or a reminder is live. A session that is neither live nor
  // persisted cannot be archived, which is not a reason to refuse an orphan id.
  const archivedByUs = await admit(registry, sessionId, warnings)

  let transcriptDirs
  try {
    transcriptDirs = await removeTranscripts(sessionId)
  } catch (error) {
    if (archivedByUs) await clearArchive(registry, sessionId, warnings)
    throw error
  }

  const workspaceDetached = await detach(owner, sessionId, warnings)
  await clearArchive(registry, sessionId, warnings)
  await clearPin(registry, sessionId, warnings)
  const projections = await removeProjectionRows(sessionId, warnings)

  // The only shipped signal that reaches every open page: the same event the
  // Session controller emits when a live session leaves the store. Pages drop
  // the row; nothing else subscribes to it.
  ctx.emit('api-session/removed', sessionId)

  return {
    ok: true,
    sessionId,
    live,
    workspace: owner?.path ?? null,
    storedCwd: stored?.header?.cwd ?? null,
    transcriptDirs,
    workspaceDetached,
    projections,
    subagentChildren: children.subagent,
    warnings,
  }
}

/**
 * Sessions created from this one. `fork` records `parentSession` on the child's
 * header, and a subagent Session records it together with `origin: 'subagent'`
 * (that is the only legal origin, see `dsh-session`).
 *
 * @param ctx - Cordis context.
 * @param sessionId - Candidate parent.
 * @returns `blocking` (visible forks the caller should remove first) and `subagent` (hidden children).
 */
async function childrenOf(ctx, sessionId) {
  const blocking = []
  const subagent = []
  const seen = new Set()

  const consider = (header) => {
    if (header === undefined || header === null || header.parentSession !== sessionId) return
    if (typeof header.id !== 'string' || seen.has(header.id)) return
    seen.add(header.id)
    if (header.origin === 'subagent') subagent.push(header.id)
    else blocking.push(header.id)
  }

  for (const session of ctx.sessions.list()) consider(session?.header)
  try {
    for (const entry of await ctx.sessionPersistence.list()) consider(entry?.header ?? entry)
  } catch (error) {
    // Fail closed: never delete a possible parent on a guess.
    const unreadable = new Error(`could not read stored sessions to check for forks of "${sessionId}": ${String(error?.message ?? error)}`)
    unreadable.code = 'session/children-unreadable'
    throw unreadable
  }

  return { blocking, subagent }
}

/** One stored header, or undefined when persistence holds no such session. */
async function readStoredHeader(ctx, sessionId) {
  try {
    return await ctx.sessionPersistence.stat(sessionId)
  } catch (error) {
    if (error?.name === 'SessionPersistenceNotFoundError' || /not found/i.test(String(error?.message))) return undefined
    throw error
  }
}

/** The workspace entity whose durable account lists this session. */
function owningWorkspace(registry, sessionId) {
  for (const workspace of registry.list()) {
    try {
      if (workspace.sessionIds.includes(sessionId)) return workspace
    } catch {
      // A workspace whose directory no longer resolves is not this session's owner.
    }
  }
  return undefined
}

/** @returns whether this call is what put the session into the archive set. */
async function admit(registry, sessionId, warnings) {
  const alreadyArchived = registry.archivedSessionIds.includes(sessionId)
  try {
    await registry.archiveSession(sessionId)
    return alreadyArchived === false
  } catch (error) {
    const errorName = error?.name ?? ''
    const message = String(error?.message ?? '')
    if (errorName === 'WorkspaceUnknownSessionError' || /neither live nor persisted/i.test(message)) {
      // An orphan id that only survives in the workspace account: nothing to admit.
      warnings.push(`admission skipped: ${message}`)
      return false
    }
    throw error
  }
}

async function clearArchive(registry, sessionId, warnings) {
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    warnings.push(`could not clear the archive set: ${String(error?.message ?? error)}`)
  }
}

async function clearPin(registry, sessionId, warnings) {
  try {
    await registry.unpinSession(sessionId)
  } catch (error) {
    warnings.push(`could not clear the pin set: ${String(error?.message ?? error)}`)
  }
}

async function detach(owner, sessionId, warnings) {
  if (owner === undefined) return false
  try {
    await owner.detachSession(sessionId)
    return true
  } catch (error) {
    warnings.push(`could not detach the workspace account: ${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * Remove every `<sessions root>/<project>/<sessionId>` directory.
 *
 * The project directory name is derived by the persistence backend's own
 * encoding, so the session directory is located by its exact id instead of
 * re-deriving that encoding here. A candidate is only removed when it looks
 * like a session directory, so a name collision cannot delete foreign files.
 */
async function removeTranscripts(sessionId) {
  const root = join(resolveHome(), 'sessions')
  const removed = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return removed
    throw error
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name, sessionId)
    const info = await statOrUndefined(dir)
    if (info === undefined || !info.isDirectory()) continue
    if (!(await looksLikeSessionDir(dir))) continue
    // Fails loudly when a live handle still owns the transcript (Windows), which
    // is exactly the signal that keeps this deletion from corrupting a session.
    await rm(dir, { recursive: true, force: false, maxRetries: 3, retryDelay: 120 })
    removed.push(dir)
  }
  return removed
}

async function looksLikeSessionDir(dir) {
  try {
    const entries = await readdir(dir)
    return entries.some((entry) => entry.startsWith('session.'))
  } catch {
    return false
  }
}

/**
 * Best-effort removal of every persisted per-record row for this id.
 *
 * A surviving row is harmless (its lifecycle identity can never match a new
 * session), but the running app holds these tables in memory and can rewrite
 * the file later, so a failure is reported as a warning, never as an error.
 */
async function removeProjectionRows(sessionId, warnings) {
  const root = join(resolveHome(), 'storages')
  const removed = []
  let units
  try {
    units = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push(`could not read the storage root: ${String(error?.message ?? error)}`)
    return removed
  }

  for (const unit of units) {
    if (!unit.isDirectory()) continue
    const candidates = [
      join(root, unit.name, 'sessions', `${sessionId}.json`),
      join(root, unit.name, `${sessionId}.json`),
    ]
    for (const candidate of candidates) {
      const info = await statOrUndefined(candidate)
      if (info === undefined || !info.isFile()) continue
      try {
        await rm(candidate, { force: false })
        removed.push(candidate)
      } catch (error) {
        warnings.push(`could not remove ${candidate}: ${String(error?.message ?? error)}`)
      }
    }
  }
  return removed
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function statOrUndefined(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** Configured home, else `$DSH_HOME`, else `~/.dsh` — the same order the Harness uses. */
function resolveHome() {
  for (const candidate of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
    if (typeof candidate === 'string' && candidate.trim() !== '' && isAbsolute(candidate)) return candidate
  }
  return join(homedir(), '.dsh')
}

/** Append one audit line (or the receipt); never lets bookkeeping break a request. */
async function record(file, value) {
  try {
    const dir = join(resolveHome(), 'session-delete')
    await mkdir(dir, { recursive: true })
    const path = join(dir, file)
    if (file.endsWith('.jsonl')) await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
    else await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  } catch {
    // A missing audit file must never fail a deletion or an activation.
  }
}

/** Map a thrown failure onto an HTTP refusal, or undefined for a real fault. */
function refusalOf(error) {
  const errorName = error?.name ?? ''
  const code = error?.code ?? ''
  const message = error instanceof Error ? error.message : String(error)

  if (code === 'session/not-found' || errorName === 'SessionPersistenceNotFoundError') {
    return { status: 404, body: { code: 'session/not-found', message } }
  }
  if (errorName === 'WorkspaceActiveSessionError' || /still running|cannot be archived/i.test(message)) {
    return { status: 409, body: { code: 'session/running', message, activity: error?.activity ?? null } }
  }
  if (code === 'session/has-children') {
    return { status: 409, body: { code: 'session/has-children', message, children: error?.children ?? [] } }
  }
  if (code === 'session/children-unreadable') {
    return { status: 409, body: { code: 'session/children-unreadable', message } }
  }
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return {
      status: 409,
      body: {
        code: 'session/in-use',
        message: `the transcript is still held open by the running app (${code}); close or switch away from this session and try again`,
      },
    }
  }
  if (code === 'ENOENT') {
    return { status: 404, body: { code: 'session/not-found', message } }
  }
  return undefined
}
