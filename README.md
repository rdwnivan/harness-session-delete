# harness-session-delete

[![CI](https://github.com/rdwnivan/harness-session-delete/actions/workflows/ci.yml/badge.svg)](https://github.com/rdwnivan/harness-session-delete/actions/workflows/ci.yml)

Delete a DeepSeek Harness session **permanently** from the sidebar session list, behind a confirmation
dialog — without leaving the workspace registry, the projection cache, or app startup in a state that
breaks *open workspace* or *New Session*.

> The Harness ships **archive**, not delete: *"Removal never deletes data … session deletion or folder
> removal are separate, absent capabilities"* (`@deepseek-ai/dsh-workspace` README). No delete exists in
> `ctx.sessionPersistence`, `ctx.sessionController`, or `ctx.workspaceRegistry`, so a deletion has to be
> sequenced by hand. That sequencing is this plugin.

🇮🇩 [Bahasa Indonesia](README.id.md)

## Requirements

- DeepSeek Harness Desktop (developed and verified against **0.2.0-rc.2** on Windows).
- For the test suites: Node 22+. No build step and no runtime dependencies.

## Install

### Through the plugin manager (recommended)

1. Open the sidebar **Plugins** page.
2. Install a bundle and give it the git address:

   ```
   github:rdwnivan/harness-session-delete
   ```

   (or `https://github.com/rdwnivan/harness-session-delete`).
3. Approve the operation — package operations need full access.
4. Read the result: `application: applied` means it is live. If it says `restart-required`, quit and
   relaunch the app once.

The package has no build script, so pnpm's blocked-build-scripts prompt never applies.

### Manually

1. Copy this folder to `<profile>/node_modules/harness-session-delete`, where `<profile>` is
   `<DSH_HOME>/profiles/<name>` (for the Desktop app: `%USERPROFILE%\.dsh\profiles\desktop`).
2. Append this to `<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: session-delete
         name: 'harness-session-delete'
   ```

3. Restart the app once — Host modules are not hot-reloaded out of `node_modules`.

## Use

1. Hover a session row in the sidebar and open its **"…"** menu (right-click works too).
2. Choose **Delete session** (destructive colour, below *Archive session*) and confirm.
3. The row disappears: transcript, projection-cache row, and workspace accounting are gone.

A session the app is still **holding live** (it was opened or ran a turn in this app run) cannot leave
`session.list` — the Host serves every resident session from memory, whatever persistence says. For that
case the plugin leaves the session's registry **archive entry** in place: that is the shipped *"hidden
from every grouping surface"* state, so the row disappears at once and stays gone, the archived-session
gate keeps the residue from running and writing its transcript back, and the app forgets the session for
good on the next launch. Leftover tombstones are swept when the plugin next activates, so the archive set
does not accumulate.

Clicking delete again on a row that is already gone (the residue of an earlier deletion) finishes the job
instead of reporting "not found": the row is hidden the same way.

## What it refuses, and why

| Response | Meaning |
|---|---|
| `409 session/running` | that session's own turn, a subagent, a job, or a reminder is still running — stop it first |
| `409 session/has-children` | a visible Session was **forked** from this one; the body lists the child to delete first |
| `409 session/children-unreadable` | stored Sessions could not be read, so the lineage check cannot be trusted; nothing is deleted |
| `409 session/in-use` | the transcript is still held open by the running app (Windows); switch away and retry |
| `404 session/not-found` | no such session: neither stored, nor resident, nor accounted for by a workspace |
| `400 invalid-session-id` | not a Session id — no filesystem path is ever derived from caller input |

## Deletion order (why it is safe)

1. **Admission** — `ctx.workspaceRegistry.archiveSession(id)`, the shipped *"what still runs for this
   session?"* gate, so nothing is ever removed under running work.
2. **Bytes first** — remove `<DSH_HOME>/sessions/<project>/<id>/`. If that fails (a locked transcript),
   the archive write is rolled back and **nothing else changed**.
3. **Bookkeeping** — `workspace.detachSession(id)`, then clear the pin set and, unless the session is
   still resident, the archive entry (a resident session keeps it as the tombstone described above).
   Always through the domain store: `workspace.json` is **never** edited by hand, because one invalid
   byte there aborts `storageDomain.open` and the GUI then cannot open workspaces at all.
4. **Cache and notice** — drop the projection-cache rows and tell every open page
   (`api-session/removed`).

## Files

| File | Role |
|---|---|
| `index.js` | Host half: two authenticated fetch routes (delete + browser receipt), the deletion sequence, the fork guard, the audit log |
| `client.js` | Browser half: the sidebar menu row and its confirmation, then a client-side list refresh so the row disappears |
| `cordis.patch.yml` | The bundle patch — one Host row; the browser half is discovered from `dsh.client` |
| `test/*.mjs` | Offline suites, the live verifier, and the verifier's own self-test |

## Verification

```bash
npm run check                          # syntax of every shipped file
npm test                               # host refusals/rollback/happy path + browser-half contract
node test/verify-live.selftest.mjs     # the verifier itself, against synthetic DSH homes
node test/verify-live.mjs --store      # store health of your installation
node test/verify-live.mjs <session-id> # post-conditions of one deletion
```

Nothing under `test/` needs the Harness: the host suite drives the real route handlers against a
temporary `DSH_HOME`, and the browser suite materializes `client.js` exactly as the Web module loader
does (`window.__ModuleLoader__.load` → `factory(require)`), then activates it against a fake client
context.

The plugin also leaves an audit trail in `<DSH_HOME>/session-delete/`:

- `status.json` — activation receipt (time, version, routes).
- `deletions.jsonl` — one line per request, refusals included; a successful line records whether the
  deletion left a tombstone for a resident session.
- `tombstones.json` — the stale archive entries cleared at the last activation, if any.
- `client.jsonl` — browser receipts (`apply`, `menu-row-render`).
- `client-graph.json` — whether the package reached the page's boot graph.

## Known limits

- Host-side changes need an app restart: the profile's HMR watches configuration and ignores
  `**/node_modules`.
- The confirmation uses the browser's native `window.confirm`. Focus and Escape handling come from the
  browser; a host-themed dialog (via the `shell.overlay` slot) is not implemented yet.
- Subagent children do not block a deletion — they are hidden from the sidebar, so blocking on them
  would make a parent permanently undeletable. They are reported in the response and left on disk.
- A session the app still holds live is hidden with an archive entry rather than removed from
  `session.list`, because no shipped API releases the app's residency; its row therefore reappears if
  that filter is set to **show archived** sessions, and it is gone completely after a relaunch.
- Deleting is irreversible: no trash, no undo.

## Uninstall

Remove the `insert` block from `<profile>/cordis.patch.yml` (or deselect the bundle on the Plugins page)
and delete the package folder. Sessions already deleted stay deleted.

## Related

- [`dsh-plugin-session-delete`](https://github.com/Amano-Natsuki/dsh-session-delete) — an independent
  plugin with the same goal. It **stops** running work instead of refusing it, blocks on forked children,
  and does not ship the audit trail or the offline verification tools.

## License

MIT
