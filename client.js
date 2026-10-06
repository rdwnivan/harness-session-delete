/**
 * Browser half of the local `session-delete` bundle.
 *
 * Adds one destructive row to the session row's "..." / right-click menu
 * (`sidebar.workspaces.session.menu.item`, order 500 — after the shipped
 * Archive row at 400), confirms, then calls the Host endpoint registered by
 * this package's `index.js`.
 *
 * Written against the lazy-CJS module-loader contract by hand: no build step,
 * no Harness Client package import (only `react`, a browser module-table seed),
 * and all styling through `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'harness-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'local.sessionDelete'
    const ROUTE = 'api/session-delete.delete'
    const HELLO = 'api/session-delete.hello'

    // Receipts for headless verification: "the browser half applied" and "the
    // menu row actually rendered". A missing receipt must never disturb the page.
    let reportedRender = false
    function report(event) {
      try {
        fetch(HELLO, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, path: location.pathname, locale: navigator.language }),
        }).catch(() => {})
      } catch {
        // ignore
      }
    }

    // The built-in pair must be complete: the object form of `locale.register`
    // is validated against both shipped locales.
    const en = {
      menu: 'Delete session',
      deleting: 'Deleting…',
      confirm: 'Permanently delete "{title}"?\n\nIts transcript and cached projection are removed from disk. This cannot be undone.',
      failed: 'Delete refused ({status}).',
      error: 'Could not delete the session: {message}',
    }
    // Registered separately as a language pack, so a rejected pack can never
    // take the menu row down with it.
    const id = {
      menu: 'Hapus sesi',
      deleting: 'Menghapus…',
      confirm: 'Hapus permanen "{title}"?\n\nTranskrip dan cache proyeksinya dibuang dari disk. Tindakan ini tidak bisa dibatalkan.',
      failed: 'Penghapusan ditolak ({status}).',
      error: 'Sesi tidak bisa dihapus: {message}',
    }
    const zh = {
      menu: '删除会话',
      deleting: '正在删除…',
      confirm: '永久删除“{title}”？\n\n会话记录与投影缓存将从磁盘移除，且无法恢复。',
      failed: '删除被拒绝（{status}）。',
      error: '无法删除会话：{message}',
    }

    // Copies the shipped menu-row geometry; only theme tokens are shared.
    const CSS = [
      '.dshSessionDeleteWrap{position:relative}',
      '.dshSessionDeleteSeparator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}',
      '.dshSessionDeleteItem{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;',
      'border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font:inherit;',
      'font-size:13px;line-height:20px;text-align:left;color:var(--dsw-alias-state-error-primary)}',
      '.dshSessionDeleteItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dshSessionDeleteItem:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
      '.dshSessionDeleteItem:disabled{opacity:.4;cursor:not-allowed}',
      '.dshSessionDeleteIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;',
      'color:var(--dsw-alias-state-error-primary)}',
      '.dshSessionDeleteLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('')

    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, [
        h('path', { key: 'lid', d: 'M2.75 4.5h10.5' }),
        h('path', { key: 'handle', d: 'M6.25 4.5V3.25h3.5V4.5' }),
        h('path', { key: 'body', d: 'M4.25 4.5l.6 8.25h6.3l.6-8.25' }),
      ])
    }

    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, afterDelete, t } = props
      const menu = typeof useMenuOpenState === 'function' ? useMenuOpenState() : [false, () => {}]
      const closeMenu = menu[1]
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (reportedRender) return
        reportedRender = true
        report('menu-row-render')
      }, [])

      const onSelect = () => {
        if (busy) return
        if (typeof closeMenu === 'function') closeMenu(false)
        const title = displayTitle || sessionId
        if (!window.confirm(t('confirm', { title }))) return

        setBusy(true)
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        }).then(async (response) => {
          const payload = await response.json().catch(() => undefined)
          if (response.ok) return payload
          // A Session that is already gone is the state the user asked for, and a
          // row can outlive its Session for one list generation: settle quietly.
          if (payload && payload.code === 'session/not-found') return payload
          const detail = payload && (payload.message || payload.code)
          throw new Error(detail || t('failed', { status: response.status }))
        }).then(() => {
          // The Host re-reads persistence for `session.list`, so refreshing the
          // client baseline is what removes the row (grouped or Ungrouped).
          if (typeof afterDelete === 'function') afterDelete(sessionId)
        }).catch((error) => {
          window.alert(t('error', { message: error instanceof Error ? error.message : String(error) }))
        }).finally(() => {
          setBusy(false)
        })
      }

      return h('div', { className: 'dshSessionDeleteWrap' }, [
        h('style', { key: 'style', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { key: 'separator', className: 'dshSessionDeleteSeparator', role: 'separator' }),
        h('button', {
          key: 'button',
          type: 'button',
          role: 'menuitem',
          className: 'dshSessionDeleteItem',
          disabled: busy,
          onClick: onSelect,
        }, [
          h('span', { key: 'icon', className: 'dshSessionDeleteIcon' }, h(TrashIcon)),
          h('span', { key: 'label', className: 'dshSessionDeleteLabel' }, busy ? t('deleting') : t('menu')),
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        report('apply')

        // After a delete the Host's `session.list` no longer holds the Session, but
        // this page keeps its last baseline: drop the local summary and re-read the
        // list — that is what removes the row, in its group or under Ungrouped.
        const afterDelete = (sessionId) => {
          const sessions = ctx.get('sessions')
          if (sessions === undefined) return
          try {
            if (typeof sessions.handleSessionRemoved === 'function') sessions.handleSessionRemoved(sessionId)
          } catch (error) {
            console.warn('session-delete: local removal notice failed', error)
          }
          try {
            if (typeof sessions.refresh === 'function') {
              Promise.resolve(sessions.refresh()).catch((error) => {
                console.warn('session-delete: session list refresh failed', error)
              })
            }
          } catch (error) {
            console.warn('session-delete: session list refresh failed', error)
          }
        }

        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-delete: dictionaries')

        // Indonesian as an optional language pack: isolated so a rejected pack
        // cannot stop the menu row from registering.
        ctx.effect(() => {
          try {
            const disposeLanguage = ctx.locale.addLanguage({ id: 'id', label: 'Bahasa Indonesia', fallback: 'en' })
            const disposeDictionary = ctx.locale.register(NS, 'id', id)
            return () => {
              if (typeof disposeDictionary === 'function') disposeDictionary()
              if (typeof disposeLanguage === 'function') disposeLanguage()
            }
          } catch (error) {
            console.warn('session-delete: Indonesian language pack not registered:', error)
            return undefined
          }
        }, 'session-delete: Indonesian pack')

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-delete',
          order: 500,
          locale: NS,
          inject: () => ({ afterDelete }),
        }, DeleteSessionMenuItem))
      },
    }
  },
})
