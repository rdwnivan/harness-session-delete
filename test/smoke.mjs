/**
 * Offline smoke test for the session-delete host half.
 *
 * Runs the registered route handlers against a throwaway DSH_HOME with fake
 * session directories, a fake projection row, and a fake workspace registry, so
 * request parsing, the on-disk scan/removal, the bookkeeping order, the refusal
 * mapping, and the browser-receipt route are exercised without the running app.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
process.env.DSH_HOME = home

const { apply, inject, name } = await import('../index.js')

assert.equal(name, 'session-delete')
assert.deepEqual(inject, ['connection', 'sessions', 'sessionPersistence', 'workspaceRegistry'])

const DELETE_PATH = '/api/session-delete.delete'
const HELLO_PATH = '/api/session-delete.hello'
const PROJECT = '--C-Users-example-workspace--'
const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const OTHER = 'session-99999999-8888-7777-6666-555555555555'
/** A subagent Session: bare uuid, accounted by no workspace. */
const SUBAGENT = '11111111-2222-3333-4444-555555555555'
/** A Session forked from SESSION (no origin; only `subagent` is a legal origin). */
const CHILD = 'session-22222222-3333-4444-5555-666666666666'
/** A Session whose only child is a hidden subagent Session. */
const PARENT = 'session-44444444-5555-6666-7777-888888888888'
/** An archived id from an earlier app run: no bytes, no live Session. */
const TOMBSTONE = 'session-00000000-1111-2222-3333-444444444444'

async function seed(sessionId) {
  const dir = join(home, 'sessions', PROJECT, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'transcript')
  const row = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(row, '{}')
  return { dir, row }
}

const seeded = await seed(SESSION)
await seed(OTHER)
const subagentSeed = await seed(SUBAGENT)
const childSeed = await seed(CHILD)
const parentSeed = await seed(PARENT)

const emitted = []
const detached = []
const unarchived = []
const graphChanges = []
let deleted = false

function makeCtx({
  live = false,
  archive,
  withModules = false,
  forgetSession = false,
  children = [],
  listFault = false,
  accounted = true,
  archived = [],
} = {}) {
  const routes = new Map()
  const ctx = {
    effect: (callback) => { callback() },
    inject: (deps, callback) => {
      if (withModules && deps.includes('clientModules')) {
        callback({
          clientModules: {
            graph: () => ({ rev: 'graph-rev-1', entries: [{ id: 'harness-session-delete', rev: 'bundle-rev-1' }], batches: [] }),
            clientPath: () => 'C:\\profile\\node_modules\\harness-session-delete\\client.js',
            onGraphChanged: (listener) => { graphChanges.push(listener); return () => {} },
          },
          effect: (callback2) => { callback2() },
        })
      }
    },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } },
    sessions: { get: (id) => (live && id === SESSION ? { id } : undefined), list: () => [] },
    sessionPersistence: {
      stat: async (id) => {
        if (!forgetSession && (id === SESSION || id === OTHER || id === SUBAGENT || id === CHILD || id === PARENT)) return { header: { id, cwd: 'C:\\workspace' } }
        const error = new Error(`session "${id}" not found`)
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      },
      list: async () => {
        if (listFault) {
          const error = new Error('storage read failed')
          error.code = 'EIO'
          throw error
        }
        return children.map((header) => ({ header }))
      },
    },
    workspaceRegistry: {
      archivedSessionIds: [...archived],
      list: () => [{
        path: 'C:\\workspace',
        sessionIds: accounted ? [SESSION] : [],
        detachSession: async (id) => { detached.push(id) },
      }],
      archiveSession: archive ?? (async () => {}),
      unarchiveSession: async (id) => { unarchived.push(id) },
      unpinSession: async () => {},
    },
    emit: (event, id) => { emitted.push([event, id]) },
  }
  return { ctx, routes }
}

const postTo = (route, body) => route.fetch(new Request(`http://local${DELETE_PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

// --- registered route shapes ------------------------------------------------
const shape = makeCtx()
apply(shape.ctx)
const deleteShape = shape.routes.get(DELETE_PATH)
assert.ok(deleteShape, 'the delete route must be registered through ctx.effect')
assert.deepEqual(deleteShape.methods, ['POST'])
assert.equal(deleteShape.requestBody, 'buffered')
assert.ok(shape.routes.has(HELLO_PATH), 'the browser-receipt route must be registered')

// --- the browser receipt writes an audit line -------------------------------
const helloResponse = await shape.routes.get(HELLO_PATH).fetch(new Request(`http://local${HELLO_PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event: 'apply', path: '/', locale: 'en-US' }),
}))
assert.equal(helloResponse.status, 200)
assert.equal((await helloResponse.json()).ok, true)

// --- the boot-graph receipt proves the browser half was published -----------
const withModules = makeCtx({ withModules: true })
apply(withModules.ctx)
await new Promise((resolve) => setTimeout(resolve, 50))
const graphReceipt = JSON.parse(await readFile(join(home, 'session-delete', 'client-graph.json'), 'utf8'))
assert.equal(graphReceipt.published, true)
assert.equal(graphReceipt.entry.id, 'harness-session-delete')
assert.equal(graphReceipt.clientPath.endsWith('client.js'), true)
assert.equal(graphChanges.length, 1, 'the receipt must also follow graph changes')
graphChanges[0]()

// --- rejections -------------------------------------------------------------
const rejectionHarness = makeCtx()
apply(rejectionHarness.ctx)
const post = (body) => postTo(rejectionHarness.routes.get(DELETE_PATH), body)

let response = await post({ sessionId: '../../etc/passwd' })
assert.equal(response.status, 400)
assert.equal((await response.json()).code, 'invalid-session-id')

// A refused request leaves an audit line too: every request that reaches the
// plugin must be answerable from <home>/session-delete/deletions.jsonl.
await new Promise((resolve) => setTimeout(resolve, 50))
assert.match(await readFile(join(home, 'session-delete', 'deletions.jsonl'), 'utf8'), /"code":"invalid-session-id"/)

response = await post({})
assert.equal(response.status, 400)

response = await post({ sessionId: 'session-00000000-0000-0000-0000-000000000000' })
assert.equal(response.status, 404)
assert.equal((await response.json()).code, 'session/not-found')

// --- a subagent Session (bare uuid, accounted by no workspace) --------------
const subagent = makeCtx()
apply(subagent.ctx)
response = await postTo(subagent.routes.get(DELETE_PATH), { sessionId: SUBAGENT })
const subagentReport = await response.json()
assert.equal(response.status, 200, 'a subagent Session must delete like any other')
assert.equal(subagentReport.workspace, null)
assert.equal(subagentReport.workspaceDetached, false)
assert.equal(subagentReport.transcriptDirs.length, 1)
await assert.rejects(stat(subagentSeed.dir), 'the subagent transcript must be gone')
await assert.rejects(stat(subagentSeed.row), 'the subagent projection row must be gone')

// --- a session whose work still runs is refused, and nothing is removed -----
const running = makeCtx({
  archive: async () => {
    const error = new Error('session is still running')
    error.name = 'WorkspaceActiveSessionError'
    throw error
  },
})
apply(running.ctx)
response = await postTo(running.routes.get(DELETE_PATH), { sessionId: SESSION })
assert.equal(response.status, 409)
assert.equal((await response.json()).code, 'session/running')
assert.ok((await stat(seeded.dir)).isDirectory(), 'a refused delete must leave the transcript in place')
assert.equal(detached.length, 0, 'a refused delete must not touch the workspace account')

// --- an id whose transcript is gone but the account still lists it ----------
// (the residue a crash between byte removal and bookkeeping leaves behind)
const orphanHome = await mkdtemp(join(tmpdir(), 'dsh-session-delete-orphan-'))
process.env.DSH_HOME = orphanHome
const orphan = makeCtx({
  forgetSession: true,
  archive: async () => {
    const error = new Error(`session "${SESSION}" is neither live nor persisted, so it cannot be archived`)
    error.name = 'WorkspaceUnknownSessionError'
    throw error
  },
})
apply(orphan.ctx)
response = await postTo(orphan.routes.get(DELETE_PATH), { sessionId: SESSION })
const orphanReport = await response.json()
assert.equal(response.status, 200, 'an orphan id must still be cleaned out of the workspace account')
assert.equal(orphanReport.workspaceDetached, true)
assert.deepEqual(orphanReport.transcriptDirs, [])
assert.equal(orphanReport.warnings.length, 1)
assert.match(orphanReport.warnings[0], /admission skipped/)
process.env.DSH_HOME = home

// --- a transcript that cannot be removed rolls the archive back -------------
const lockedHome = await mkdtemp(join(tmpdir(), 'dsh-session-delete-locked-'))
await writeFile(join(lockedHome, 'sessions'), 'not a directory')
await mkdir(join(lockedHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
const lockedRow = join(lockedHome, 'storages', 'session_projcache', 'sessions', `${SESSION}.json`)
await writeFile(lockedRow, '{}')
process.env.DSH_HOME = lockedHome
const detachedBefore = detached.length
const emittedBefore = emitted.length
const unarchivedBefore = unarchived.length
const locked = makeCtx()
apply(locked.ctx)
response = await postTo(locked.routes.get(DELETE_PATH), { sessionId: SESSION })
const lockedBody = await response.json()
assert.equal(response.status, 500)
assert.equal(lockedBody.code, 'failed')
assert.equal(unarchived.length, unarchivedBefore + 1, 'a failed byte removal must roll the archive back')
assert.equal(unarchived.at(-1), SESSION)
assert.equal(detached.length, detachedBefore, 'a failed byte removal must not detach the workspace account')
assert.equal(emitted.length, emittedBefore, 'a failed byte removal must not tell pages the session is gone')
assert.ok((await stat(lockedRow)).isFile(), 'projection rows must survive a failed deletion')
process.env.DSH_HOME = home

// --- a forked child refuses the parent's deletion ---------------------------
const forked = makeCtx({ children: [{ id: CHILD, parentSession: SESSION, isSeeded: true }] })
apply(forked.ctx)
response = await postTo(forked.routes.get(DELETE_PATH), { sessionId: SESSION })
const forkedBody = await response.json()
assert.equal(response.status, 409)
assert.equal(forkedBody.code, 'session/has-children')
assert.deepEqual(forkedBody.children, [CHILD])
assert.ok((await stat(seeded.dir)).isDirectory(), 'a refused parent must keep its transcript')
assert.ok((await stat(childSeed.dir)).isDirectory(), 'the forked child must be untouched')

// --- a lineage that cannot be read fails closed -----------------------------
const unreadableLineage = makeCtx({ listFault: true })
apply(unreadableLineage.ctx)
response = await postTo(unreadableLineage.routes.get(DELETE_PATH), { sessionId: SESSION })
assert.equal(response.status, 409)
assert.equal((await response.json()).code, 'session/children-unreadable')
assert.ok((await stat(seeded.dir)).isDirectory(), 'an unreadable lineage must not delete anything')

// --- a hidden subagent child does not block, and is reported ----------------
const withSubagentChild = makeCtx({ children: [{ id: CHILD, parentSession: PARENT, origin: 'subagent' }] })
apply(withSubagentChild.ctx)
response = await postTo(withSubagentChild.routes.get(DELETE_PATH), { sessionId: PARENT })
const parentReport = await response.json()
assert.equal(response.status, 200, 'a hidden subagent child must not make a parent undeletable')
assert.deepEqual(parentReport.subagentChildren, [CHILD])
await assert.rejects(stat(parentSeed.dir), 'the parent transcript must be gone')
assert.ok((await stat(childSeed.dir)).isDirectory(), 'the subagent child must survive its parent')

// --- happy path -------------------------------------------------------------
const detachedBeforeHappy = detached.length
const emittedBeforeHappy = emitted.length
const unarchivedBeforeHappy = unarchived.length
const happy = makeCtx({ live: true })
apply(happy.ctx)
response = await postTo(happy.routes.get(DELETE_PATH), { sessionId: SESSION })
const report = await response.json()
assert.equal(response.status, 200)
assert.equal(report.ok, true)
assert.equal(report.sessionId, SESSION)
assert.equal(report.live, true)
assert.equal(report.tombstone, true, 'a resident Session keeps its archive entry as the deletion tombstone')
assert.equal(report.workspaceDetached, true)
assert.equal(report.transcriptDirs.length, 1)
assert.equal(report.projections.length, 1)
assert.deepEqual(report.warnings, [])
await assert.rejects(stat(seeded.dir), 'the transcript directory must be gone')
await assert.rejects(stat(seeded.row), 'the projection row must be gone')
assert.equal(detached.length, detachedBeforeHappy + 1)
assert.equal(detached.at(-1), SESSION)
assert.equal(emitted.length, emittedBeforeHappy + 1)
assert.deepEqual(emitted.at(-1), ['api-session/removed', SESSION])
assert.equal(unarchived.length, unarchivedBeforeHappy, 'a resident Session must not be unarchived: the entry is what hides the row')
assert.ok((await stat(join(home, 'sessions', PROJECT, OTHER))).isDirectory(), 'sibling sessions must survive')
deleted = true

// --- a Session the app no longer holds drops its archive entry --------------
// (nothing serves it any more, so a tombstone would only leave the registry
// counting an id that can never be shown or restored)
const quietSeed = await seed(SESSION)
const quiet = makeCtx()
apply(quiet.ctx)
response = await postTo(quiet.routes.get(DELETE_PATH), { sessionId: SESSION })
const quietReport = await response.json()
assert.equal(response.status, 200)
assert.equal(quietReport.live, false)
assert.equal(quietReport.tombstone, false, 'a non-resident Session leaves no tombstone behind')
assert.equal(unarchived.at(-1), SESSION, 'a non-resident Session has its archive entry cleared')
assert.deepEqual(quietReport.warnings, [])
await assert.rejects(stat(quietSeed.dir), 'the transcript directory must be gone')

// --- the residue of an earlier deletion finishes instead of refusing --------
// The user's report: a resident Session whose bytes are already gone and whose
// accounting was already detached. Retrying used to answer `session/not-found`,
// which the page treats as "already gone" while the row stayed on screen.
const residueEmittedBefore = emitted.length
const residue = makeCtx({ live: true, forgetSession: true, accounted: false })
apply(residue.ctx)
response = await postTo(residue.routes.get(DELETE_PATH), { sessionId: SESSION })
const residueReport = await response.json()
assert.equal(response.status, 200, 'a resident residue must be hidden, not refused')
assert.equal(residueReport.ok, true)
assert.equal(residueReport.residual, true)
assert.equal(residueReport.tombstone, true)
assert.equal(residueReport.live, true)
assert.equal(residueReport.workspace, null)
assert.deepEqual(residueReport.transcriptDirs, [])
assert.equal(emitted.length, residueEmittedBefore + 1)
assert.deepEqual(emitted.at(-1), ['api-session/removed', SESSION])

// --- an id nobody knows is still refused -----------------------------------
const unknown = makeCtx({ accounted: false, forgetSession: true })
apply(unknown.ctx)
response = await postTo(unknown.routes.get(DELETE_PATH), { sessionId: SESSION })
assert.equal(response.status, 404, 'an unknown, non-resident id stays not-found')
assert.equal((await response.json()).code, 'session/not-found')

// --- tombstones of an earlier run are swept, live/persisted ids are kept ----
const sweptBefore = unarchived.length
const stale = makeCtx({ archived: [TOMBSTONE, OTHER] })
apply(stale.ctx)
await new Promise((resolve) => setTimeout(resolve, 50))
assert.deepEqual(unarchived.slice(sweptBefore), [TOMBSTONE], 'only a tombstone with nothing left to hide is cleared')
const sweep = JSON.parse(await readFile(join(home, 'session-delete', 'tombstones.json'), 'utf8'))
assert.equal(sweep.event, 'stale-tombstones-cleared')
assert.deepEqual(sweep.cleared, [TOMBSTONE])
assert.equal(sweep.kept, 1, 'a persisted Session keeps its archive entry')

// --- audit trails -----------------------------------------------------------
const deletions = await readFile(join(home, 'session-delete', 'deletions.jsonl'), 'utf8')
assert.match(deletions, /"sessionId":"session-11111111/)
const clients = await readFile(join(home, 'session-delete', 'client.jsonl'), 'utf8')
assert.match(clients, /"event":"apply"/)
const status = await readFile(join(home, 'session-delete', 'status.json'), 'utf8')
assert.match(status, /"route":\s*"\/api\/session-delete\.delete"/)

delete process.env.DSH_HOME
await rm(home, { recursive: true, force: true })
await rm(orphanHome, { recursive: true, force: true })
await rm(lockedHome, { recursive: true, force: true })
assert.equal(deleted, true)
console.log('smoke: all assertions passed')
