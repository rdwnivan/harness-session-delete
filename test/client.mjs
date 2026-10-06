/**
 * Offline contract test for the session-delete browser half.
 *
 * Materializes `client.js` the way the Web module loader does (`window.__ModuleLoader__.load`
 * → `factory(require)`), then activates it against a fake Cordis client context and
 * renders the registered menu row with a React stub. This proves the bundle's own
 * contract — module id, exports, slot registration, locale dictionaries, rendered
 * markup, and the delete request it sends — without an authenticated page.
 *
 * Run: node test/client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const PACKAGE_NAME = 'harness-session-delete'
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- module table
let registration
const window = {
  __ModuleLoader__: { load: (entry) => { registration = entry } },
  confirm: () => false,
  alert: (message) => alerts.push(message),
}
const fetched = []
const pinged = []
const alerts = []

const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useState: (initial) => [initial, () => {}],
  useEffect: (callback) => { callback() },
}

const require = (specifier) => {
  if (specifier === 'react') return react
  throw new Error(`unexpected require("${specifier}") — the bundle must resolve only from the browser module table`)
}

let nextResponse = undefined
const fakeFetch = (url, init) => {
  const record = { url, init, body: init?.body ? JSON.parse(init.body) : undefined }
  if (url.includes('hello')) pinged.push(record)
  else fetched.push(record)
  const response = nextResponse ?? { ok: true, status: 200, body: { ok: true } }
  nextResponse = undefined
  return Promise.resolve({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
  })
}

const location = { pathname: '/' }
const navigator = { language: 'en-US' }
const consoleWarn = []
const fakeConsole = { warn: (...args) => consoleWarn.push(args), log: () => {}, error: () => {} }

new Function('window', 'fetch', 'location', 'navigator', 'console', source)(
  window, fakeFetch, location, navigator, fakeConsole,
)

assert.equal(registration.id, PACKAGE_NAME, 'the module id must equal the package name')
assert.equal(typeof registration.factory, 'function')

const browserHalf = registration.factory(require)
assert.deepEqual(browserHalf.inject, ['slots', 'locale'], 'the bundle must declare its client services')
assert.equal(typeof browserHalf.apply, 'function')

// ------------------------------------------------------------------ activation
const dictionaries = []
const languages = []
const registrations = []
const effects = []
const sessionCalls = { removed: [], refreshed: 0 }
const sessionsService = {
  handleSessionRemoved: (id) => { sessionCalls.removed.push(id) },
  refresh: () => { sessionCalls.refreshed++; return Promise.resolve() },
}

const ctx = {
  effect: (callback, label) => { effects.push(label); callback() },
  get: (name) => (name === 'sessions' ? sessionsService : undefined),
  locale: {
    register: (...args) => { dictionaries.push(args); return () => {} },
    addLanguage: (definition) => { languages.push(definition); return () => {} },
  },
  slots: {
    inject: (key, callback) => { callback(); return () => {} },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}

browserHalf.apply(ctx)

assert.equal(dictionaries[0][0], 'local.sessionDelete')
assert.equal(dictionaries[0][1].en.menu, 'Delete session')
assert.equal(dictionaries[0][1].zh.menu, '删除会话')
assert.ok(dictionaries[0][1].en.confirm.includes('{title}'), 'the confirmation must interpolate the title')
assert.deepEqual(languages, [{ id: 'id', label: 'Bahasa Indonesia', fallback: 'en' }])
assert.deepEqual(dictionaries[1], ['local.sessionDelete', 'id', dictionaries[1][2]])
assert.equal(dictionaries[1][2].menu, 'Hapus sesi')
assert.equal(consoleWarn.length, 0, 'the optional language pack must not warn')

assert.equal(registrations.length, 1)
assert.equal(registrations[0].options.name, 'sidebar.workspaces.session.menu.item')
assert.equal(registrations[0].options.id, 'session-delete')
assert.equal(registrations[0].options.order, 500, 'the row must sort after the shipped Archive row (400)')
assert.equal(registrations[0].options.locale, 'local.sessionDelete')
assert.equal(effects.length, 2, 'the two dictionaries and the language pack run as owned effects')

assert.ok(pinged.some((record) => record.url === 'api/session-delete.hello' && record.body.event === 'apply'),
  'activation must report a receipt')

// ------------------------------------------------------------------- rendering
const interpolate = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? ''))
const translate = (key, params) => interpolate(dictionaries[0][1].en[key], params)

const closed = []
const face = registrations[0].options.inject()
assert.equal(typeof face.afterDelete, 'function', 'the row must receive the post-delete behavior')
const render = (confirmResult) => {
  const confirmations = []
  window.confirm = (text) => { confirmations.push(text); return confirmResult }
  const tree = registrations[0].component({
    sessionId: 'session-11111111-2222-3333-4444-555555555555',
    displayTitle: 'Judul Sesi',
    useMenuOpenState: () => [false, (value) => closed.push(value)],
    afterDelete: face.afterDelete,
    t: translate,
  })
  return { tree, confirmations }
}

const cancelled = render(false)
assert.equal(cancelled.tree.type, 'div')
const cancelledStyle = cancelled.tree.children.find((child) => child.type === 'style')
assert.ok(cancelledStyle, 'the row must carry its own scoped styles')
assert.match(cancelledStyle.props.dangerouslySetInnerHTML.__html, /--dsw-alias-state-error-primary/)
assert.match(cancelledStyle.props.dangerouslySetInnerHTML.__html, /dshSessionDeleteItem:hover/, 'copied classes must be plugin-prefixed')

const cancelledButton = cancelled.tree.children.find((child) => child.type === 'button')
assert.equal(cancelledButton.props.role, 'menuitem')
assert.equal(cancelledButton.props.type, 'button')
assert.equal(cancelledButton.props.disabled, false)
const cancelledLabel = cancelledButton.children.find((child) => child.type === 'span' && child.props.className === 'dshSessionDeleteLabel')
assert.deepEqual(cancelledLabel.children, ['Delete session'])

cancelledButton.props.onClick()
await Promise.resolve()
assert.equal(cancelled.confirmations.length, 1, 'selecting the row must ask before deleting')
assert.equal(fetched.length, 0, 'a declined confirmation must not reach the Host')
assert.deepEqual(closed, [false], 'selecting the row must dismiss the menu')

const accepted = render(true)
const button = accepted.tree.children.find((child) => child.type === 'button')
button.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))

assert.equal(accepted.confirmations.length, 1)
assert.ok(accepted.confirmations[0].includes('Judul Sesi'), 'the confirmation must name the session')
assert.equal(fetched.length, 1)
assert.equal(fetched[0].url, 'api/session-delete.delete', 'the request must go to the Host route, document-relative')
assert.equal(fetched[0].init.method, 'POST')
assert.deepEqual(fetched[0].body, { sessionId: 'session-11111111-2222-3333-4444-555555555555' })

// A successful delete must drop the local summary and re-read the Host baseline:
// that is what removes the row, grouped or Ungrouped.
assert.deepEqual(sessionCalls.removed, ['session-11111111-2222-3333-4444-555555555555'])
assert.ok(sessionCalls.refreshed >= 1, 'a successful delete must refresh the session list')
assert.deepEqual(alerts, [], 'a successful delete must stay quiet')

// Clicking a row whose Session is already gone settles quietly and still refreshes,
// so a stale Ungrouped row disappears instead of raising an error.
const before = sessionCalls.refreshed
nextResponse = { ok: false, status: 404, body: { code: 'session/not-found', message: 'not stored' } }
const stale = render(true)
stale.tree.children.find((child) => child.type === 'button').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.ok(sessionCalls.refreshed > before, 'an already-gone row must still refresh the list')
assert.deepEqual(alerts, [], 'an already-gone row must not raise an error notice')

// A real refusal still surfaces, and does not pretend the row disappeared.
nextResponse = { ok: false, status: 409, body: { code: 'session/in-use', message: 'transcript is still held open' } }
const refused = render(true)
refused.tree.children.find((child) => child.type === 'button').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(alerts.length, 1, 'a real refusal must be shown')
assert.ok(alerts[0].includes('still held open'), 'the refusal message must reach the user')

console.log('client: all assertions passed')
