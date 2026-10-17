window.__ModuleLoader__.load({
  id: 'dsh-floatball-pet',
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
      nav: '灵动岛悬浮球',
      enable: '启用灵动岛悬浮球',
      enableHint: '关掉只是停止悬浮球进程，灵动岛的外观与偏好设置都原样保留。',
      version: '版本',
      check: '检查更新',
      checking: '正在查询更新…',
      latest: '已是最新版本',
      update: '更新到',
      updating: '正在下载并安装…装完需要重启 DSH',
      updated: '已安装，重启 DSH 后生效',
      restart: '已安装完成；完全退出并重新打开 DSH 才会加载新版本。',
      unavailable: '插件宿主没有提供设置接口（webServer 不可用），这个面板暂时读不到状态。',
      running: '运行中',
      stopped: '已关闭',
      missingRuntime: '找不到悬浮球运行时',
      size: '悬浮球大小',
      opacity: '不透明度',
      pin: '灵动岛常驻展开',
      pinHint: '开启后一直展开；拖动悬浮球时临时收起',
      islandColor: '灵动岛颜色',
      gearColor: '设置按钮颜色',
      reset: '恢复默认',
      icon: '悬浮球图标',
      iconDefault: '默认立绘',
      chooseIcon: '选择图片…',
      clearIcon: '恢复默认',
      cropHint: '拖动图片调整位置，滑块缩放；圆内就是最终效果',
      cropDefaultHint: '选择图片后可拖动和缩放',
      zoom: '缩放',
      center: '居中',
      confirm: '确认',
      cancel: '取消',
      applied: '已应用到悬浮球',
      tooBig: '图片太大（最大 12 MB）',
      readFailed: '读取图片失败',
    }

    async function request(path, options) {
      const response = await fetch(`/.dsh-floatball-pet${path}`, {
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
      if (!response.ok) {
        // A 404 with HTML is not our route answering: the request fell through to the
        // app shell, which means the host half has not registered its routes (it needs
        // the webServer service, injected) — usually because that half was updated and
        // DSH has not been restarted yet.
        if (response.status === 404 && !parsed) {
          throw new Error('插件宿主还没注册接口（多半是刚更新完还没重启 DSH）。完全退出并重新打开 DSH 后再试。')
        }
        throw new Error((parsed && parsed.error) || `HTTP ${response.status}`)
      }
      return parsed || {}
    }

    function settingsFromConfig(config) {
      return {
        ...(config && config.settings ? config.settings : {}),
        ballImageName: (config && config.ballImageName) || null,
        ballImageVersion: config && config.ballImageVersion != null ? config.ballImageVersion : null,
      }
    }

    /**
     * The icon preview comes from the plugin host rather than a file:// URL: the
     * settings page is a normal web page, and the host already knows how to fall
     * back to the built-in art when the picked file disappeared. The version is the
     * file's mtime, so replacing an icon keeps the browser from showing a stale copy.
     */
    function iconSource(value) {
      const version = value && value.ballImageVersion != null
        ? String(value.ballImageVersion)
        : (value && value.ballImage ? String(value.ballImage) : 'default')
      return `/.dsh-floatball-pet/icon?v=${encodeURIComponent(version)}`
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

    function Slider({ label, value, min, max, step, display, onChange }) {
      return React.createElement('div', { className: 'dsh-pet-set-field' },
        React.createElement('div', { className: 'dsh-pet-set-row' },
          React.createElement('div', { className: 'dsh-pet-set-label' }, label),
          React.createElement('div', { className: 'dsh-pet-set-value' }, display)),
        React.createElement('input', {
          className: 'dsh-pet-set-range',
          type: 'range',
          min,
          max,
          step,
          value,
          onChange: (event) => onChange(Number(event.target.value)),
        }))
    }

    function ColorRow({ label, value, hint, onChange, onReset }) {
      return React.createElement(Row, { label, hint },
        React.createElement('div', { className: 'dsh-pet-set-buttons' },
          React.createElement('input', {
            className: 'dsh-pet-set-color',
            type: 'color',
            value: value || '#425ca5',
            onChange: (event) => onChange(event.target.value),
            'aria-label': label,
          }),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-pet-set-btn',
            onClick: onReset,
          }, copy.reset)))
    }

    const CROP_OFFSET_MAX = 100

    // Offsets are a percentage of the pan room, not of the ball diameter. ±100 puts
    // the picture's edge exactly on the circle's edge; the clamped value therefore
    // guarantees the round preview is always fully covered.
    function clampCrop(value) {
      const n = Number(value)
      return Number.isFinite(n) ? Math.min(CROP_OFFSET_MAX, Math.max(-CROP_OFFSET_MAX, n)) : 0
    }

    function coverBox(scale, ratio) {
      const ar = Number(ratio)
      const parsedScale = Number(scale)
      const aspect = Number.isFinite(ar) && ar > 0 ? ar : 1
      const zoom = Number.isFinite(parsedScale) ? Math.min(4, Math.max(1, parsedScale)) : 1
      return {
        width: Math.max(1, aspect) * zoom,
        height: Math.max(1, 1 / aspect) * zoom,
      }
    }

    /**
     * The round viewport. The <img> is deliberately larger than the box (its
     * shorter side is at least one diameter, more when zoomed), so dragging only
     * moves the already-covering picture inside the circle and can never expose a
     * gap at the border. The circle itself is square in CSS, hence a true circle.
     */
    function CropCircle({ src, scale, offsetX, offsetY, disabled, onChange }) {
      const circle = React.useRef(null)
      const drag = React.useRef(null)
      const [ratio, setRatio] = React.useState(1)
      const box = coverBox(scale, ratio)
      const x = clampCrop(offsetX)
      const y = clampCrop(offsetY)
      const left = (box.width - 1) * 50 * (x / 100 - 1)
      const top = (box.height - 1) * 50 * (y / 100 - 1)

      React.useEffect(() => {
        const img = circle.current && circle.current.querySelector('img')
        if (!img) return
        // A cached image may never fire `load`; read its decoded size directly.
        setRatio(img.complete && img.naturalWidth > 0 ? img.naturalWidth / img.naturalHeight : 1)
      }, [src])

      const pointerDown = (event) => {
        if (disabled || event.button !== 0 || !circle.current) return
        const rect = circle.current.getBoundingClientRect()
        const roomX = (box.width - 1) / 2
        const roomY = (box.height - 1) / 2
        if (roomX <= 0 && roomY <= 0) return
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          offsetX: x,
          offsetY: y,
          width: rect.width,
          height: rect.height,
          roomX,
          roomY,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not fatal */ }
        event.preventDefault()
      }

      const pointerMove = (event) => {
        const start = drag.current
        if (!start) return
        let nextX = start.offsetX
        let nextY = start.offsetY
        if (start.roomX > 0 && start.width > 0) {
          nextX = clampCrop(start.offsetX + ((event.clientX - start.x) / (start.width * start.roomX)) * 100)
        }
        if (start.roomY > 0 && start.height > 0) {
          nextY = clampCrop(start.offsetY + ((event.clientY - start.y) / (start.height * start.roomY)) * 100)
        }
        onChange({ offsetX: nextX, offsetY: nextY })
      }

      const pointerUp = () => { drag.current = null }

      return React.createElement('div', {
        className: `dsh-pet-set-crop${disabled ? ' is-disabled' : ''}`,
        ref: circle,
        // Inline mask as well as CSS: the host hot-reloads this module while the
        // settings page stays open, and a stale style tag must never turn the
        // preview into a rounded square again.
        style: {
          width: 96,
          height: 96,
          flex: 'none',
          borderRadius: '50%',
          clipPath: 'circle(50% at 50% 50%)',
          overflow: 'hidden',
          position: 'relative',
        },
        onPointerDown: pointerDown,
        onPointerMove: pointerMove,
        onPointerUp: pointerUp,
        onPointerCancel: pointerUp,
      }, React.createElement('img', {
        src,
        alt: '',
        draggable: false,
        onLoad: (event) => {
          const img = event.currentTarget
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            setRatio(img.naturalWidth / img.naturalHeight)
          }
        },
        style: {
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
          left: `${left}%`,
          top: `${top}%`,
        },
      }))
    }

    /**
     * The icon adjustment UI, always under the icon row. In `draft` mode it edits
     * the file that has just been picked (confirm/cancel); otherwise it edits the
     * icon that is already on the ball, saving as the sliders move.
     */
    function CropEditor({ src, scale, offsetX, offsetY, editable, hint, onChange, actions }) {
      const parsedScale = Number(scale)
      const zoom = Number.isFinite(parsedScale) ? Math.min(4, Math.max(1, parsedScale)) : 1
      return React.createElement('div', { className: 'dsh-pet-set-crop-box' },
        React.createElement(CropCircle, {
          src,
          scale: zoom,
          offsetX,
          offsetY,
          disabled: !editable,
          onChange,
        }),
        React.createElement('div', { className: 'dsh-pet-set-crop-controls' },
          React.createElement('div', { className: 'dsh-pet-set-hint' }, hint),
          React.createElement('div', { className: 'dsh-pet-set-row' },
            React.createElement('span', { className: 'dsh-pet-set-label' }, copy.zoom),
            React.createElement('span', { className: 'dsh-pet-set-value' }, `${zoom.toFixed(2)}×`)),
          React.createElement('input', {
            className: 'dsh-pet-set-range',
            type: 'range',
            min: 1,
            max: 4,
            step: 0.05,
            value: zoom,
            disabled: !editable,
            onChange: (event) => onChange({ scale: Number(event.target.value) }),
          }),
          React.createElement('div', { className: 'dsh-pet-set-buttons' },
            React.createElement('button', {
              key: 'center',
              type: 'button',
              className: 'dsh-pet-set-btn',
              disabled: !editable,
              onClick: () => onChange({ scale: 1, offsetX: 0, offsetY: 0 }),
            }, copy.center),
            actions)))
    }

    function PetSettings() {
      const [status, setStatus] = React.useState(null)
      const [settings, setSettings] = React.useState(null)
      const [release, setRelease] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [ready, setReady] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const fileInput = React.useRef(null)
      const pending = React.useRef({})
      const saveTimer = React.useRef(null)
      const localEditAt = React.useRef(0)

      const load = React.useCallback(async () => {
        try {
          const [nextStatus, config] = await Promise.all([request('/status'), request('/settings')])
          setStatus(nextStatus)
          setSettings(settingsFromConfig(config))
          setError('')
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setReady(true)
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      // The floating ball's own panel and the tray write the same preferences.json.
      // Poll it while this page is visible so a size/opacity change made in the
      // ball shows up here instead of waiting for a reload. Local edits and the
      // 160 ms save window win over the poll: otherwise a slow response could put
      // the knob back under the user's finger.
      React.useEffect(() => {
        let stopped = false
        const tick = async () => {
          if (stopped || document.visibilityState === 'hidden') return
          if (draft || Object.keys(pending.current).length || saveTimer.current) return
          if (Date.now() - localEditAt.current < 1800) return
          try {
            const config = await request('/settings')
            if (stopped) return
            setSettings((current) => {
              if (Object.keys(pending.current).length || saveTimer.current) return current
              return settingsFromConfig(config)
            })
            setError('')
          } catch {
            // A poll is a convenience; a transient failure must not replace the
            // page's real error (or pop one up while the user is just watching).
          }
        }
        const timer = setInterval(tick, 1500)
        const refresh = () => { void tick() }
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          stopped = true
          clearInterval(timer)
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
        }
      }, [draft])

      const save = (patch) => {
        localEditAt.current = Date.now()
        setSettings((current) => ({ ...(current || {}), ...patch }))
        pending.current = { ...pending.current, ...patch }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(async () => {
          const body = pending.current
          pending.current = {}
          saveTimer.current = null
          try {
            const result = await request('/settings', { body: JSON.stringify(body) })
            if (result.settings) {
              const stillPending = pending.current
              setSettings((current) => ({
                ...(current || {}),
                ...result.settings,
                ...stillPending,
                ballImageName: result.ballImageName !== undefined
                  ? result.ballImageName
                  : (current && current.ballImageName) ?? null,
                ballImageVersion: result.ballImageVersion !== undefined
                  ? result.ballImageVersion
                  : (current && current.ballImageVersion) ?? null,
              }))
            }
            setError('')
          } catch (err) {
            setError(err.message || String(err))
          }
        }, 160)
      }

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

      const pickIcon = (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        if (!/^image\//.test(file.type)) {
          setError('请选择图片文件（PNG / JPG / GIF / WebP / BMP）')
          return
        }
        if (file.size > 12 * 1024 * 1024) {
          setError(copy.tooBig)
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          setError('')
          setDraft({
            dataUrl: String(reader.result || ''),
            name: file.name,
            scale: 1,
            offsetX: 0,
            offsetY: 0,
          })
        }
        reader.onerror = () => setError(copy.readFailed)
        reader.readAsDataURL(file)
      }

      const confirmIcon = async () => {
        if (!draft) return
        setBusy('icon')
        setError('')
        try {
          const result = await request('/icon', {
            body: JSON.stringify({
              dataUrl: draft.dataUrl,
              scale: draft.scale,
              offsetX: draft.offsetX,
              offsetY: draft.offsetY,
            }),
          })
          if (result.settings) setSettings(settingsFromConfig(result))
          setDraft(null)
          setNote(copy.applied)
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setBusy('')
        }
      }

      const clearIcon = async () => {
        setBusy('icon')
        setError('')
        try {
          const result = await request('/settings', { body: JSON.stringify({ ballImage: null }) })
          if (result.settings) setSettings(settingsFromConfig(result))
          setDraft(null)
          setNote(copy.applied)
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setBusy('')
        }
      }

      if (!ready) return React.createElement('div', { className: 'dsh-pet-set-empty' }, '读取中…')

      const available = Boolean(status)
      const versionText = status && status.version ? `v${status.version}` : '—'
      const stateText = status ? (status.enabled ? copy.running : copy.stopped) : ''
      const value = settings || {}

      const editingIcon = draft
        ? {
          src: draft.dataUrl,
          scale: draft.scale,
          offsetX: draft.offsetX,
          offsetY: draft.offsetY,
          editable: true,
          hint: copy.cropHint,
        }
        : {
          src: iconSource(value),
          scale: value.ballImage ? (value.ballImageScale == null ? 1 : value.ballImageScale) : 1,
          offsetX: value.ballImage ? (value.ballImageOffsetX == null ? 0 : value.ballImageOffsetX) : 0,
          offsetY: value.ballImage ? (value.ballImageOffsetY == null ? 0 : value.ballImageOffsetY) : 0,
          editable: Boolean(value.ballImage),
          hint: value.ballImage ? copy.cropHint : copy.cropDefaultHint,
        }

      const onCropChange = (patch) => {
        if (draft) {
          setDraft((current) => (current ? { ...current, ...patch } : current))
          return
        }
        if (!value.ballImage) return
        const nextScale = patch.scale === undefined
          ? (value.ballImageScale == null ? 1 : value.ballImageScale)
          : patch.scale
        const nextX = patch.offsetX === undefined
          ? (value.ballImageOffsetX == null ? 0 : value.ballImageOffsetX)
          : patch.offsetX
        const nextY = patch.offsetY === undefined
          ? (value.ballImageOffsetY == null ? 0 : value.ballImageOffsetY)
          : patch.offsetY
        save({
          ballImageScale: Math.min(4, Math.max(1, Number(nextScale) || 1)),
          ballImageOffsetX: clampCrop(nextX),
          ballImageOffsetY: clampCrop(nextY),
        })
      }

      const cropActions = draft
        ? [
          React.createElement('button', {
            key: 'confirm',
            type: 'button',
            className: 'dsh-pet-set-btn is-primary',
            disabled: busy === 'icon',
            onClick: confirmIcon,
          }, copy.confirm),
          React.createElement('button', {
            key: 'cancel',
            type: 'button',
            className: 'dsh-pet-set-btn',
            disabled: busy === 'icon',
            onClick: () => setDraft(null),
          }, copy.cancel),
        ]
        : null

      return React.createElement('section', { className: 'dsh-pet-set' },
        React.createElement('h2', { className: 'dsh-pet-set-title' }, copy.nav),

        error ? React.createElement('div', { className: 'dsh-pet-set-error-row' },
          React.createElement('p', { className: 'dsh-pet-set-error' }, error),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-pet-set-btn',
            onClick: () => { void load() },
          }, '重试')) : null,
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

        React.createElement(Slider, {
          label: copy.size,
          value: value.ballSize || 56,
          min: 40,
          max: 96,
          step: 2,
          display: `${value.ballSize || 56} px`,
          onChange: (next) => save({ ballSize: next }),
        }),

        React.createElement(Slider, {
          label: copy.opacity,
          value: Math.round((value.opacity == null ? 1 : value.opacity) * 100),
          min: 35,
          max: 100,
          step: 5,
          display: `${Math.round((value.opacity == null ? 1 : value.opacity) * 100)}%`,
          onChange: (next) => save({ opacity: next / 100 }),
        }),

        React.createElement(Row, {
          label: copy.pin,
          hint: copy.pinHint,
        }, React.createElement(Switch, {
          checked: value.islandPinned === true,
          label: copy.pin,
          onChange: (next) => save({ islandPinned: next }),
        })),

        React.createElement(ColorRow, {
          label: copy.islandColor,
          value: value.islandColor,
          onChange: (next) => save({ islandColor: next }),
          onReset: () => save({ islandColor: null }),
        }),

        React.createElement(ColorRow, {
          label: copy.gearColor,
          value: value.gearColor,
          onChange: (next) => save({ gearColor: next }),
          onReset: () => save({ gearColor: null }),
        }),

        React.createElement(Row, {
          label: copy.icon,
          hint: value.ballImageName || copy.iconDefault,
        }, React.createElement('div', { className: 'dsh-pet-set-buttons' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-pet-set-btn',
            onClick: () => { if (fileInput.current) fileInput.current.click() },
          }, copy.chooseIcon),
          React.createElement('input', {
            ref: fileInput,
            type: 'file',
            accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp',
            style: { display: 'none' },
            onChange: pickIcon,
          }),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-pet-set-btn',
            disabled: !value.ballImage || busy === 'icon',
            onClick: clearIcon,
          }, copy.clearIcon))),

        React.createElement(CropEditor, {
          src: editingIcon.src,
          scale: editingIcon.scale,
          offsetX: editingIcon.offsetX,
          offsetY: editingIcon.offsetY,
          editable: editingIcon.editable,
          hint: editingIcon.hint,
          onChange: onCropChange,
          actions: cropActions,
        }),

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
.dsh-pet-set-title { margin: 0 0 6px; font-size: 20px; }
.dsh-pet-set-field { padding: 12px 0; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.dsh-pet-set-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dsh-pet-set-label { font-size: 13px; font-weight: 600; }
.dsh-pet-set-value { font-size: 12px; opacity: 0.72; font-variant-numeric: tabular-nums; }
.dsh-pet-set-hint { margin-top: 3px; font-size: 11px; opacity: 0.65; line-height: 1.5; }
.dsh-pet-set-control { flex: none; display: flex; align-items: center; }
.dsh-pet-set-buttons { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.dsh-pet-set-range { width: 100%; margin-top: 9px; accent-color: var(--dsw-alias-button-info-fill, #2f6fed); }
.dsh-pet-set-color {
  width: 38px; height: 28px; padding: 2px; border-radius: 7px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent);
}
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
.dsh-pet-set-error-row { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
.dsh-pet-set-note { margin: 8px 0 0; font-size: 12px; opacity: 0.75; line-height: 1.5; }
.dsh-pet-set-empty { font-size: 12px; opacity: 0.6; }
.dsh-pet-set-crop-box {
  display: flex; gap: 18px; align-items: flex-start; padding: 12px 0;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.dsh-pet-set-crop {
  width: 96px; height: 96px; flex: none; border-radius: 50%; overflow: hidden;
  clip-path: circle(50% at 50% 50%);
  background: #10162e; cursor: grab; touch-action: none; position: relative;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 18%, transparent);
}
.dsh-pet-set-crop::after {
  content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 28%, transparent);
}
.dsh-pet-set-crop:not(.is-disabled):active { cursor: grabbing; }
.dsh-pet-set-crop.is-disabled { cursor: default; }
.dsh-pet-set-crop img {
  position: absolute; pointer-events: none; user-select: none; -webkit-user-drag: none;
  max-width: none; max-height: none; object-fit: cover; transform-origin: 50% 50%;
  border-radius: 0;
}
.dsh-pet-set-crop-controls { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.dsh-pet-set-crop-controls .dsh-pet-set-buttons { justify-content: flex-start; }
`
    const STYLE_ID = 'dsh-floatball-pet-settings-style'

    const inject = ['slots']

    function apply(ctx) {
      // Always rewrite the style tag instead of only creating it once. This plugin
      // is hot-reloaded while the settings page stays open, so a style tag from the
      // previous version would otherwise keep the old (non-circular) crop mask
      // forever — the exact reason a freshly updated preview could still look like
      // a rounded square.
      let node = document.getElementById(STYLE_ID)
      if (!node) {
        node = document.createElement('style')
        node.id = STYLE_ID
        document.head.append(node)
      }
      node.textContent = style
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-floatball-pet',
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
