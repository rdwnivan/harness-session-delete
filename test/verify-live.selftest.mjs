/**
 * Deterministic exercises for verify-live.mjs, so the verifier is never a
 * vacuous checker: every scenario is a throwaway DSH home assembled here and
 * checked through the exported logic (no subprocess, so it runs anywhere).
 *
 * Run: node test/verify-live.selftest.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderReport, verifyHome } from './verify-live.mjs'

const DELETED = 'session-gone-2222-2222-2222-222222222222'
const KEPT = 'session-keep-1111-1111-1111-111111111111'

/**
 * Assemble a fake DSH home.
 * @param options.deletedAccounted - workspace.json still lists DELETED.
 * @param options.deletedDir - DELETED has a transcript directory.
 * @param options.audit - deletions.jsonl mentions DELETED.
 * @param options.duplicate - DELETED exists in two project directories.
 * @param options.tombstone - the audit line says the deletion left a tombstone.
 * @param options.archived - workspace.json lists DELETED as archived.
 */
async function makeHome(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'harness-session-delete-'))
  const project = join(home, 'sessions', '--C-project--')
  const kept = join(project, KEPT)
  await mkdir(kept, { recursive: true })
  await writeFile(join(kept, 'session.v4.jsonl.zstd'), 'x')

  if (options.deletedDir || options.duplicate) {
    for (const name of options.duplicate ? ['--C-project--', '--C-other--'] : ['--C-project--']) {
      const dir = join(home, 'sessions', name, DELETED)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
    }
  }

  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['W1'],
      archivedSessionIds: options.archived ? [DELETED] : [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        W1: {
          path: 'C:\\project',
          title: 'project',
          sessionIds: options.deletedAccounted ? [KEPT, DELETED] : [KEPT],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }, null, 2))

  if (options.audit) {
    await mkdir(join(home, 'session-delete'), { recursive: true })
    await writeFile(
      join(home, 'session-delete', 'deletions.jsonl'),
      `{"sessionId":"${DELETED}","ok":false,"code":"session/not-found"}\n`
      + `{"sessionId":"${DELETED}","ok":true,"live":${options.tombstone === true},"tombstone":${options.tombstone === true}}\n`,
    )
  }
  return home
}

const homes = []
try {
  // A finished deletion passes.
  const done = await makeHome({ audit: true })
  homes.push(done)
  const doneReport = await verifyHome({ home: done, sessionId: DELETED })
  assert.equal(doneReport.failures, 0, renderReport(doneReport).join('\n'))
  assert.match(renderReport(doneReport).at(-1), /SEMUA PEMERIKSAAN LOLOS/)

  // A recorded tombstone passes with the archived entry still in place ...
  const tombstoned = await makeHome({ audit: true, tombstone: true, archived: true })
  homes.push(tombstoned)
  const tombstonedReport = await verifyHome({ home: tombstoned, sessionId: DELETED })
  assert.equal(tombstonedReport.failures, 0, renderReport(tombstonedReport).join('\n'))
  assert.ok(
    renderReport(tombstonedReport).some((line) => line.startsWith('PASS  tertinggal di archivedSessionIds')),
    renderReport(tombstonedReport).join('\n'),
  )

  // ... and a tombstone the audit does not claim fails, in both directions.
  const strayArchive = await makeHome({ audit: true, archived: true })
  homes.push(strayArchive)
  const strayReport = await verifyHome({ home: strayArchive, sessionId: DELETED })
  assert.ok(strayReport.failures > 0, 'an unrecorded archived entry must fail')
  assert.ok(
    strayReport.checks.filter((entry) => !entry.ok).some((entry) => entry.label.startsWith('tidak tertinggal di archivedSessionIds')),
    renderReport(strayReport).join('\n'),
  )

  const missingArchive = await makeHome({ audit: true, tombstone: true })
  homes.push(missingArchive)
  const missingReport = await verifyHome({ home: missingArchive, sessionId: DELETED })
  assert.ok(missingReport.failures > 0, 'a recorded tombstone must be present in the registry')
  assert.ok(
    missingReport.checks.filter((entry) => !entry.ok).some((entry) => entry.label.startsWith('tertinggal di archivedSessionIds')),
    renderReport(missingReport).join('\n'),
  )

  // Nothing deleted yet fails, and names the right checks.
  const untouched = await makeHome({ deletedAccounted: true, deletedDir: true })
  homes.push(untouched)
  const untouchedReport = await verifyHome({ home: untouched, sessionId: DELETED })
  assert.ok(untouchedReport.failures > 0, 'an untouched session must fail')
  const untouchedFailed = untouchedReport.checks.filter((entry) => !entry.ok).map((entry) => entry.label)
  assert.ok(untouchedFailed.some((label) => label.startsWith('direktori transkrip terhapus')), untouchedFailed.join(' | '))
  assert.ok(untouchedFailed.some((label) => label.startsWith('keanggotaan workspace dilepas')), untouchedFailed.join(' | '))
  assert.ok(untouchedFailed.some((label) => label.startsWith('baris audit')), untouchedFailed.join(' | '))

  // Dangling membership: accounted with no transcript on disk.
  const dangling = await makeHome({ deletedAccounted: true, audit: true })
  homes.push(dangling)
  const danglingReport = await verifyHome({ home: dangling, sessionId: DELETED })
  assert.ok(danglingReport.failures > 0, 'dangling membership must fail')
  assert.ok(
    danglingReport.checks.filter((entry) => !entry.ok).some((entry) => entry.label.startsWith('tidak ada keanggotaan menggantung')),
    renderReport(danglingReport).join('\n'),
  )

  // Duplicate id across project directories: the startup brick.
  const duplicate = await makeHome({ duplicate: true, audit: true })
  homes.push(duplicate)
  const duplicateReport = await verifyHome({ home: duplicate, sessionId: DELETED })
  assert.ok(duplicateReport.failures > 0, 'duplicate ids must fail')
  assert.ok(
    duplicateReport.checks.filter((entry) => !entry.ok).some((entry) => entry.label.startsWith('tidak ada id sesi duplikat')),
    renderReport(duplicateReport).join('\n'),
  )

  // Store-health mode catches the store invariants and skips per-session checks.
  const storeReport = await verifyHome({ home: duplicate, storeOnly: true })
  assert.ok(storeReport.failures > 0, 'store mode must still catch duplicates')
  assert.ok(
    !storeReport.checks.some((entry) => entry.label.startsWith('direktori transkrip terhapus')),
    'store mode must skip per-session checks',
  )
} finally {
  for (const home of homes) await rm(home, { recursive: true, force: true })
}

console.log('verify-live self-test: all assertions passed')
