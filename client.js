window.__ModuleLoader__.load({
  id: 'dsh-desktop-pet',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /**
     * The floating ball's page inside DSH's own settings.
     *
     * Everything it shows comes from the plugin's host half over HTTP on the same origin
     * (the pattern the other desktop plugins use), so this file stays a plain view: it
     * never touches the pet process, the profile, or the file system.
     */
    const copy = {
      nav: '悬浮球',
      intro: '桌宠悬浮球与灵动岛。这里只控制它开不开、以及版本更新；大小、图标、灵动岛这些外观设置在悬浮球自己的齿轮面板里。',
      enable: '启用悬浮球',
      enableHint: '关掉只是停止悬浮球进程，灵动岛的外观与偏好设置都原样保留。',
      version: '版本',
      check: '检查更新',
      checking: '正在查询 GitHub…',
      latest: '已是最新版本',
      update: '更新到',
      updating: '正在下载并安装…装完需要重启 DSH',
      updated: '已安装，重启 DSH 后生效',
      restart: '已安装完成；完全退出并重新打开 DSH 才会加载新版本。',
      unavailable: '插件宿主没有提供设置接口（webServer 不可用），这个面板暂时读不到状态。',
      running: '运行中',
      stopped: '已关闭',
      missingRuntime: '找不到悬浮球运行时',
    }

    async function request(path, options) {
      const response = await fetch(`/.dsh-desktop-pet${path}`, {
        method: options && options.body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const text = await response.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      if (!response.ok) throw new Error((parsed && parsed.error) || `HTTP ${response.status}`)
      return parsed || {}
    }

    function Row({ label, children, hint }) {
      return React.createElement('div', { className: 'dsh-pet-set-field' },
        React.createElement('div', { className: 'dsh-pet-set-row' },
          React.createElement('div', null,
            React.createElement('div', { className: 'dsh-pet-set-label' }, label),
            hint ? React.createElement('div', { className: 'dsh-pet-set-hint' }, hint) : null),
          React.createElement('div', { className: 'dsh-pet-set-control' }, children)))
    }

    function Switch({ checked, disabled, onChange, label }) {
      return React.createElement('button', {
        type: 'button',
        className: `dsh-pet-set-switch${checked ? ' is-on' : ''}`,
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
      })
    }

    function PetSettings() {
      const [status, setStatus] = React.useState(null)
      const [release, setRelease] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [ready, setReady] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          setStatus(await request('/status'))
          setError('')
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setReady(true)
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const toggleBall = async (enabled) => {
        setBusy('ball')
        setError('')
        try {
          const result = await request('/ball', { body: JSON.stringify({ enabled }) })
          setStatus((current) => ({ ...(current || {}), enabled: result.enabled, running: result.running }))
          setNote(enabled ? '' : copy.enableHint)
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setBusy('')
        }
      }

      const check = async () => {
        setBusy('check')
        setError('')
        setNote(copy.checking)
        try {
          const result = await request('/check', { body: JSON.stringify({}) })
          setRelease(result)
          setNote(result.newer ? '' : copy.latest)
        } catch (err) {
          setNote('')
          setError(err.message || String(err))
        } finally {
          setBusy('')
        }
      }

      const update = async () => {
        setBusy('update')
        setError('')
        setNote(copy.updating)
        try {
          const result = await request('/update', { body: JSON.stringify(release || {}) })
          if (result.alreadyLatest) setNote(copy.latest)
          else if (result.ok) {
            setNote(copy.restart)
            setStatus((current) => ({ ...(current || {}), version: result.version, enabled: true, running: false }))
          } else {
            setError(`安装失败（退出码 ${result.code}）：${(result.output || '').slice(-300)}`)
            setNote('')
          }
        } catch (err) {
          setNote('')
          setError(err.message || String(err))
        } finally {
          setBusy('')
        }
      }

      if (!ready) return React.createElement('div', { className: 'dsh-pet-set-empty' }, '读取中…')

      const available = Boolean(status)
      const versionText = status && status.version ? `v${status.version}` : '—'
      const stateText = status ? (status.enabled ? copy.running : copy.stopped) : ''

      return React.createElement('section', { className: 'dsh-pet-set' },
        React.createElement('h2', { className: 'dsh-pet-set-title' }, copy.nav),
        React.createElement('p', { className: 'dsh-pet-set-intro' }, copy.intro),

        error ? React.createElement('p', { className: 'dsh-pet-set-error' }, error) : null,
        !available && !error ? React.createElement('p', { className: 'dsh-pet-set-error' }, copy.unavailable) : null,
        status && !status.runtimeReady ? React.createElement('p', { className: 'dsh-pet-set-error' }, copy.missingRuntime) : null,

        React.createElement(Row, {
          label: copy.enable,
          hint: copy.enableHint,
        }, React.createElement(Switch, {
          checked: available ? status.enabled : false,
          disabled: !available || busy === 'ball',
          label: copy.enable,
          onChange: toggleBall,
        })),

        React.createElement(Row, {
          label: copy.version,
          hint: stateText ? `${versionText} · ${stateText}` : versionText,
        }, React.createElement('div', { className: 'dsh-pet-set-buttons' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-pet-set-btn',
            disabled: !available || busy !== '',
            onClick: check,
          }, busy === 'check' ? copy.checking : copy.check),
          release && release.newer
            ? React.createElement('button', {
              type: 'button',
              className: 'dsh-pet-set-btn is-primary',
              disabled: busy !== '',
              onClick: update,
            }, busy === 'update'
              ? copy.updating
              : `${copy.update} v${release.latest}${release.assetSize ? `（${(release.assetSize / 1048576).toFixed(1)} MB）` : ''}`)
            : null)),

        note ? React.createElement('p', { className: 'dsh-pet-set-note' }, note) : null,
      )
    }

    const style = `
.dsh-pet-set { display: flex; flex-direction: column; gap: 4px; }
.dsh-pet-set-title { margin: 0; font-size: 20px; }
.dsh-pet-set-intro { margin: 2px 0 10px; font-size: 12px; opacity: 0.7; line-height: 1.6; }
.dsh-pet-set-field { padding: 12px 0; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.dsh-pet-set-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dsh-pet-set-label { font-size: 13px; font-weight: 600; }
.dsh-pet-set-hint { margin-top: 3px; font-size: 11px; opacity: 0.65; line-height: 1.5; }
.dsh-pet-set-control { flex: none; display: flex; align-items: center; }
.dsh-pet-set-buttons { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.dsh-pet-set-btn {
  height: 28px; padding: 0 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; font: inherit; font-size: 12px;
  cursor: pointer; transition: background 120ms ease;
}
.dsh-pet-set-btn:hover:not(:disabled) { background: color-mix(in srgb, currentColor 14%, transparent); }
.dsh-pet-set-btn:disabled { opacity: 0.5; cursor: default; }
.dsh-pet-set-btn.is-primary { background: var(--dsw-alias-button-info-fill, #2f6fed); border-color: transparent; color: #fff; }
.dsh-pet-set-switch {
  width: 40px; height: 24px; border-radius: 999px; border: 0; position: relative; flex: none; cursor: pointer;
  background: color-mix(in srgb, currentColor 18%, transparent); transition: background 120ms ease;
}
.dsh-pet-set-switch::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
  background: var(--dsw-static-neutral-bluish-00, #fff); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 120ms ease;
}
.dsh-pet-set-switch.is-on { background: var(--dsw-alias-button-info-fill, #2f6fed); }
.dsh-pet-set-switch.is-on::after { transform: translateX(16px); }
.dsh-pet-set-switch:disabled { opacity: 0.5; cursor: default; }
.dsh-pet-set-error { margin: 4px 0; font-size: 12px; color: #e5484d; line-height: 1.5; }
.dsh-pet-set-note { margin: 8px 0 0; font-size: 12px; opacity: 0.75; line-height: 1.5; }
.dsh-pet-set-empty { font-size: 12px; opacity: 0.6; }
`
    const STYLE_ID = 'dsh-desktop-pet-settings-style'

    const inject = ['slots']

    function apply(ctx) {
      if (!document.getElementById(STYLE_ID)) {
        const node = document.createElement('style')
        node.id = STYLE_ID
        node.textContent = style
        document.head.append(node)
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-desktop-pet',
        order: 26,
        label: () => copy.nav,
        inject: () => ({}),
      }, PetSettings))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
