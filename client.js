// 美团外卖 · 设置页：登录 / 口味 / 浏览器
window.__ModuleLoader__.load({
  id: '@local/dsh-meituan',
  factory(require) {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    const API = '/dsh-meituan/api'

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8ee)',
      sub: 'var(--dsw-alias-label-secondary, #b8b8c4)',
      faint: 'var(--dsw-alias-label-tertiary, #8d8d9c)',
      border: 'var(--dsw-alias-border-primary, rgba(255,255,255,.12))',
      bg: 'var(--dsw-alias-bg-secondary, #191920)',
      input: 'var(--dsw-alias-bg-primary, #101016)',
      accent: 'var(--dsw-alias-brand-primary, #6aa9ff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      ok: 'var(--dsw-alias-state-success-primary, #59d18b)',
      warn: 'var(--dsw-alias-state-warning-primary, #ffc53d)',
    }

    const S = {
      card: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px', background: C.bg, marginBottom: '12px' },
      title: { fontSize: '13px', fontWeight: 700, color: C.text, marginBottom: '8px' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      input: { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '7px 9px', fontSize: '12px', outline: 'none', width: '100%', boxSizing: 'border-box' },
      small: { color: C.faint, fontSize: '11px', lineHeight: 1.7 },
      btn: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '6px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer' },
      primary: { border: `1px solid ${C.accent}`, background: C.accent, color: '#08111f', borderRadius: '6px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer', fontWeight: 600 },
      list: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '6px 8px', maxHeight: '220px', overflow: 'auto', marginTop: '8px' },
      line: { display: 'flex', gap: '8px', padding: '4px 0', borderBottom: `1px dashed ${C.border}`, fontSize: '12px', color: C.text, wordBreak: 'break-all' },
      label: { color: C.sub, fontSize: '12px', width: '72px', flexShrink: 0 },
    }

    async function api(path, options = {}) {
      const init = { method: options.method || 'GET', headers: { 'content-type': 'application/json' }, cache: 'no-store' }
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch {
        throw new Error('连不上美团外卖后端：插件可能还没启动，或刚重启没就绪')
      }
      const raw = await response.text().catch(() => '')
      let data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        throw new Error(`后端返回的不是 JSON：${raw.slice(0, 120)}`)
      }
      if (!data?.ok) throw new Error(data?.error || `请求失败 ${response.status}`)
      return data
    }

    const toList = (text) => String(text || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)

    function MeituanPage() {
      const [config, setConfig] = useState(null)
      const [taste, setTaste] = useState(null)
      const [status, setStatus] = useState(null)
      const [phone, setPhone] = useState('')
      const [code, setCode] = useState('')
      const [sent, setSent] = useState(false)
      const [likesText, setLikesText] = useState('')
      const [dislikesText, setDislikesText] = useState('')
      const [note, setNote] = useState('')
      const [preview, setPreview] = useState([])
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [addressText, setAddressText] = useState('')
      const [addressRows, setAddressRows] = useState([])
      const [addressNote, setAddressNote] = useState('')

      const applyTaste = (value) => {
        setTaste(value)
        setLikesText((value.likes || []).join('、'))
        setDislikesText((value.dislikes || []).join('、'))
        setNote(value.note || '')
      }

      const reload = async () => {
        const data = await api('/status')
        setStatus(data.status)
        setConfig(data.config)
        applyTaste(data.taste)
        setAddressText((prev) => prev || String(data.config?.address || ''))
        if (data.status?.phone) setPhone((prev) => prev || String(data.status.phone))
      }

      useEffect(() => {
        reload().catch((e) => setError(e.message))
      }, [])

      const guard = async (key, fn) => {
        setError('')
        setNotice('')
        setBusy(key)
        try {
          await fn()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const sendCode = () => guard('send', async () => {
        if (!/^\d{11}$/.test(phone.trim())) throw new Error('手机号要填 11 位数字')
        setNotice('正在叫浏览器打开美团登录页…（首次要十几秒）')
        const data = await api('/login/send', { method: 'POST', body: { phone: phone.trim() } })
        setSent(true)
        setNotice(data.clicked ? '验证码已发送，看下手机短信' : '手机号已填好，但「发送验证码」没点到——可以点「打开可见窗口」亲眼看一下')
        await reload()
      })

      const verify = () => guard('verify', async () => {
        if (!/^\d{4,6}$/.test(code.trim())) throw new Error('验证码是 4~6 位数字')
        const data = await api('/login/verify', { method: 'POST', body: { code: code.trim() } })
        if (!data.result?.ok) throw new Error(data.result?.hint || '没登进去')
        setCode('')
        setNotice('登录成功，以后不用再登了')
        await reload()
      })

      const logout = () => guard('logout', async () => {
        await api('/logout', { method: 'POST' })
        setSent(false)
        setNotice('已退出美团登录')
        await reload()
      })

      const saveTaste = () => guard('taste', async () => {
        const data = await api('/taste', {
          method: 'POST',
          body: {
            likes: toList(likesText),
            dislikes: toList(dislikesText),
            spicy: taste?.spicy ?? 2,
            budget: taste?.budget ?? 30,
            health: !!taste?.health,
            note,
          },
        })
        applyTaste(data.taste)
        setNotice('口味档案已保存')
      })

      const patchTaste = (patch) => guard('taste2', async () => {
        const data = await api('/taste', { method: 'POST', body: patch })
        applyTaste(data.taste)
      })

      const saveConfig = (patch) => guard('config', async () => {
        const data = await api('/config', { method: 'POST', body: patch })
        setConfig(data.config)
        setNotice('设置已保存')
      })

      const loadAddresses = () => guard('addrlist', async () => {
        setAddressNote('正在打开美团读你的收货地址…（几秒）')
        const data = await api('/addresses')
        setAddressRows(data.rows || [])
        setAddressNote(
          data.rows?.length
            ? `读到 ${data.rows.length} 条，点一条就填进上面的输入框`
            : '没读到地址，先在上面登录',
        )
      })

      const saveAddress = () => guard('addr', async () => {
        const value = addressText.trim()
        if (!value) throw new Error('先写个地名，例如「公司」「家」')
        setAddressNote('正在保存并切商圈…（美团要重开一次页面，十几秒）')
        const data = await api('/address', { method: 'POST', body: { address: value } })
        setConfig(data.config)
        setAddressNote(data.switched?.ok ? `已切到：${data.switched.after || value}` : `已保存；切商圈没成功（${data.switched?.reason || '先登录'}），下次挑店时会再试`)
        setNotice('送餐地点已保存')
      })

      const runPreview = () => guard('preview', async () => {
        setNotice('正在让浏览器抓附近商家…（未登录只能拿首页那 5 家）')
        const data = await api('/test/list', { method: 'POST', body: { limit: 6 } })
        setPreview(data.shops || [])
        setNotice(`抓到 ${data.total} 家店`)
        await reload()
      })

      const refreshStatus = () => guard('check', async () => {
        setNotice('正在打开美团首页看登录态…')
        const data = await api('/check', { method: 'POST' })
        setStatus(data.status)
        setSent(!!data.status?.loggedIn)
        setNotice(data.status?.loggedIn ? '已登录 ✓' : '还是没登录，再登一次')
        await reload()
      })

      const openVisible = () => guard('open', async () => {
        setNotice('正在切换成可见窗口并打开美团登录页…（几秒）')
        let data
        try {
          data = await api('/login/open', { method: 'POST' })
        } catch (e) {
          // 插件刚更新、宿主还没重载时这条路可能不存在：退化成「把窗口显示打开」
          await api('/config', { method: 'POST', body: { headless: false } })
          setSent(true)
          setNotice('已经把浏览器切成可见窗口了。现在填手机号点「发送验证码」，弹出的窗口会停在登录页，可以在那儿看着完成。')
          await reload()
          return
        }
        setSent(true)
        setNotice(data.hasInput
          ? '窗口已打开：在里面输手机号点「发送验证码」、填验证码点「登录」，完了回来点「检查登录状态」'
          : `窗口开了但没找到登录输入框（页面 ${data.url}）——看一下那个窗口现在显示什么`)
        await reload()
      })

      if (!config) return h('div', { style: S.small }, error || '正在加载美团外卖…')

      const loggedIn = !!status?.loggedIn

      return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
        h('div', { style: { ...S.small, marginBottom: '8px' } },
          '不知道吃什么的时候，直接跟 DSH 说「用美团帮我挑个外卖」。它自己开浏览器逛美团、按你的口味排序，把能直接下单的店链接发给你；也能把菜做成二维码、以及在电脑上走到结算页。工具：meituan_pick / meituan_menu / meituan_shops / meituan_cart / meituan_order / meituan_login / meituan_taste。'),
        error ? h('div', { style: { color: C.danger, fontSize: '12px', marginBottom: '8px' } }, error) : null,
        notice ? h('div', { style: { color: C.ok, fontSize: '12px', marginBottom: '8px' } }, notice) : null,

        // 登录
        h('div', { style: S.card },
          h('div', { style: S.title }, '美团登录'),
          h('div', { style: { ...S.small, marginBottom: '8px', color: loggedIn ? C.ok : C.faint } },
            loggedIn
              ? `已登录${status?.phone ? `：${String(status.phone).slice(0, 3)}****${String(status.phone).slice(-4)}` : ''}｜登录资料存在插件自己的 data/browser-profile/`
              : '未登录。只看附近商家列表不用登录；进店铺看菜单、搜索、看自己地址必须登录。'),
          h('div', { style: S.row },
            h('input', {
              style: { ...S.input, width: '150px' },
              value: phone,
              placeholder: '11 位手机号',
              inputMode: 'numeric',
              maxLength: 11,
              onChange: (e) => setPhone(e.target.value.replace(/\D/g, '')),
            }),
            h('button', { style: S.primary, onClick: sendCode, disabled: busy === 'send' }, busy === 'send' ? '发送中…' : '发送验证码'),
            h('button', { style: S.btn, onClick: logout, disabled: busy === 'logout' }, '退出登录'),
          ),
          sent || loggedIn
            ? h('div', { style: { ...S.row, marginTop: '8px' } },
                h('input', {
                  style: { ...S.input, width: '150px' },
                  value: code,
                  placeholder: '短信验证码',
                  inputMode: 'numeric',
                  maxLength: 6,
                  onChange: (e) => setCode(e.target.value.replace(/\D/g, '')),
                }),
                h('button', { style: S.primary, onClick: verify, disabled: busy === 'verify' }, busy === 'verify' ? '登录中…' : '登录'),
                h('button', { style: S.btn, onClick: refreshStatus, disabled: busy === 'check' }, busy === 'check' ? '检查中…' : '检查登录状态'),
              )
            : null,
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h('button', { style: S.btn, onClick: openVisible, disabled: busy === 'open' },
              busy === 'open' ? '正在打开…' : '在可见窗口里自己登（弹出的窗口里输手机号）'),
          ),
          h('div', { style: S.small }, '美团会往这个手机号发短信；验证码只填进登录页，插件不会存到别处。如果点了没反应，把下面「显示浏览器窗口」打开，肉眼看着它操作。'),
        ),

        // 送餐地点
        h('div', { style: S.card },
          h('div', { style: S.title }, '送餐地点（挑店、下单都按它）'),
          h('div', { style: { ...S.small, marginBottom: '8px' } },
            '留空就用美团里默认的那个。填个地名关键字就行（例如「公司」「家」）；不确定就点「读取我的美团地址」，从列表里点一条。'),
          h('div', { style: S.row },
            h('input', {
              style: { ...S.input, width: '220px' },
              value: addressText,
              placeholder: '地名关键字，例如 公司',
              onChange: (e) => setAddressText(e.target.value),
            }),
            h('button', { style: S.primary, onClick: saveAddress, disabled: busy === 'addr' },
              busy === 'addr' ? '保存中…' : '保存并切到这儿'),
            h('button', { style: S.btn, onClick: loadAddresses, disabled: busy === 'addrlist' },
              busy === 'addrlist' ? '读取中…' : '读取我的美团地址'),
          ),
          addressRows.length
            ? h('div', { style: S.list }, addressRows.map((row) => h('div', {
                key: row.id || row.name,
                style: { ...S.line, cursor: 'pointer' },
                onClick: () => setAddressText(row.name),
              },
                h('span', { style: { color: C.faint, width: '18px' } }, row.tag === '默认' ? '★' : ''),
                h('span', { style: { flex: 1 } }, row.name + (row.detail && row.detail !== row.name ? `｜${row.detail}` : '')),
                row.outOfRange ? h('span', { style: { color: C.warn } }, '超范围') : null,
              )))
            : null,
          addressNote ? h('div', { style: { ...S.small, marginTop: '6px' } }, addressNote) : null,
        ),

        // 口味
        h('div', { style: S.card },
          h('div', { style: S.title }, '口味档案（挑店依据）'),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('span', { style: S.label }, '爱吃的'),
            h('input', { style: { ...S.input, width: '300px' }, value: likesText, placeholder: '川菜、面条、鸡肉（用、或逗号分隔）', onChange: (e) => setLikesText(e.target.value) }),
          ),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('span', { style: S.label }, '不吃的'),
            h('input', { style: { ...S.input, width: '300px' }, value: dislikesText, placeholder: '香菜、螺蛳粉、太油', onChange: (e) => setDislikesText(e.target.value) }),
          ),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('span', { style: S.label }, '辣度'),
            ...['不吃辣', '微微辣', '正常辣', '无辣不欢'].map((label, index) =>
              h('button', {
                key: label,
                style: taste?.spicy === index ? S.primary : S.btn,
                onClick: () => patchTaste({ spicy: index }),
              }, label)),
          ),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('span', { style: S.label }, '人均预算'),
            h('input', {
              style: { ...S.input, width: '90px' },
              value: String(taste?.budget ?? ''),
              inputMode: 'numeric',
              onChange: (e) => setTaste({ ...taste, budget: Number(e.target.value.replace(/\D/g, '')) || 0 }),
            }),
            h('span', { style: { ...S.small, marginLeft: '4px' } }, '元 / 顿'),
            h('button', { style: S.btn, onClick: () => patchTaste({ health: !taste?.health }) }, taste?.health ? '⚑ 正在控卡' : '控卡：关'),
          ),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('span', { style: S.label }, '备注'),
            h('input', { style: { ...S.input, width: '300px' }, value: note, placeholder: '最近想吃清淡的 / 别老是那几家', onChange: (e) => setNote(e.target.value) }),
          ),
          h('button', { style: S.primary, onClick: saveTaste, disabled: busy === 'taste' }, busy === 'taste' ? '保存中…' : '保存口味'),
          h('div', { style: S.small }, '挑店时会按这些打分：命中爱好加、命中忌口减、超出预算减、评分/距离/配送时间也计入。'),
        ),

        // 浏览器
        h('div', { style: S.card },
          h('div', { style: S.title }, '浏览器与抓取'),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('button', { style: config.headless ? S.btn : S.primary, onClick: () => saveConfig({ headless: !config.headless }) },
              config.headless ? '后台静默运行（当前）' : '显示浏览器窗口（当前）'),
            h('button', { style: S.btn, onClick: () => api('/browser/stop', { method: 'POST' }).then(reload).catch((e) => setError(e.message)) }, '关掉浏览器'),
          ),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('span', { style: S.label }, '浏览器'),
            h('input', {
              style: { ...S.input, width: '340px' },
              value: config.browserPath || '',
              placeholder: '留空自动找 Edge / Chrome',
              onChange: (e) => setConfig({ ...config, browserPath: e.target.value }),
            }),
            h('button', { style: S.btn, onClick: () => saveConfig({ browserPath: config.browserPath || '' }) }, '记住'),
          ),
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('span', { style: S.label }, '候选家数'),
            h('input', {
              style: { ...S.input, width: '80px' },
              value: String(config.limit ?? 12),
              inputMode: 'numeric',
              onChange: (e) => {
                const next = Number(e.target.value.replace(/\D/g, '')) || 0
                setConfig({ ...config, limit: next })
              },
            }),
            h('button', { style: S.btn, onClick: () => saveConfig({ limit: config.limit }) }, '记住'),
            h('span', { style: { ...S.small, marginLeft: '4px' } }, '每次从多少家里挑；未登录时首页只给 5 家'),
          ),
          h('div', { style: S.row },
            h('button', { style: S.primary, onClick: runPreview, disabled: busy === 'preview' }, busy === 'preview' ? '抓取中…' : '试抓一次附近商家'),
          ),
          h('div', { style: S.small }, `浏览器：${status?.browser?.exe ? status.browser.exe : '还没启动'}${status?.browser?.running ? '（运行中）' : ''}`),
          preview.length
            ? h('div', { style: S.list },
                preview.map((shop, index) => h('div', { style: S.line, key: `${shop.id}-${index}` },
                  h('span', { style: { color: C.accent } }, shop.name),
                  h('span', { style: { color: C.faint } }, [shop.score ? `${shop.score}分` : '', shop.deliveryTip, shop.distance].filter(Boolean).join(' · ')),
                  h('span', { style: { color: C.warn } }, shop.avgPrice ? `¥${shop.avgPrice}` : ''),
                )))
            : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-meituan',
          order: 71,
          label: () => '美团外卖',
        }, MeituanPage))
      },
    }
  },
})
