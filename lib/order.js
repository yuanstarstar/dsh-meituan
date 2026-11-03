// 结算/下单相关的 DOM 操作：只读 + 点按钮，具体「点不点提交」由上层决定
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const PREVIEW_PATH = '/waimai/mindex/preview'
export const ADDRESSLIST_PATH = '/waimai/mindex/addresslist'
export const POIPICKER_PATH = '/waimai/mindex/poipicker'

async function text(browser, limit = 1600) {
  return browser.evaluate(`document.body ? document.body.innerText.slice(0, ${limit}) : ''`)
}

/** 页面上文本等于 text 的最小元素中心点（可见、尺寸合理）。取最小是因为外层容器也含同样的字 */
export async function pointOfText(browser, wanted, { exact = true } = {}) {
  return browser.evaluate(`(() => {
    const wanted = ${JSON.stringify(wanted)}
    const exact = ${exact}
    let best = null
    for (const el of document.querySelectorAll('div,span,button,a,p,section')) {
      const t = (el.textContent || '').trim()
      if (exact ? t !== wanted : !t.includes(wanted)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      if (r.top < 0 || r.top > innerHeight) continue
      const area = r.width * r.height
      if (!best || area < best.area) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t.slice(0, 40), area }
    }
    return best
  })()`)
}

/** 结算页状态：地址、费用、合计、餐具、提交按钮 */
export async function readPreview(browser) {
  const body = await text(browser, 2400)
  const address = await browser.evaluate(`(() => {
    const hits = [...document.querySelectorAll('div,span,a,p')].filter(
      (el) => /先生|女士/.test(String(el.textContent || '')) && el.childElementCount <= 3 && String(el.textContent || '').length < 80,
    )
    if (!hits.length) return ''
    hits.sort((a, b) => String(a.textContent).length - String(b.textContent).length)
    const el = hits[0]
    const box = el.parentElement && String(el.parentElement.innerText || '').length < 120 ? el.parentElement : el
    return String(box.innerText || el.innerText || '').replace(/\\n/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 90)
  })()`)
  const tableware = await browser.evaluate(`(() => {
    const lines = document.body.innerText.split('\\n')
    const i = lines.findIndex((line) => /餐具/.test(line))
    return i >= 0 ? lines.slice(i, i + 3).join(' / ') : ''
  })()`)
  const total = await browser.evaluate(`(() => {
    const m = document.body.innerText.match(/合计\\s*¥?\\s*([\\d.]+)/)
    return m ? Number(m[1]) : 0
  })()`)
  const hasSubmit = !!(await pointOfText(browser, '提交订单'))
  const needsTableware = /餐具数量[^\\n]*请选择|请选择/.test(tableware) || /餐具[^\\n]*必选/.test(body)
  return { url: await browser.evaluate('location.href'), address, tableware, total, hasSubmit, needsTableware, text: body.slice(0, 900) }
}

/** 找「按钮」中心点：文本完全等于 wanted，取面积最大但不超过 40000 的那个（按钮本体，不是外层容器） */
export async function pointOfButton(browser, wanted) {
  return browser.evaluate(`(() => {
    const hits = []
    for (const el of document.querySelectorAll('div,span,button,a')) {
      const t = (el.textContent || '').trim()
      if (t !== ${JSON.stringify(wanted)}) continue
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 16) continue
      if (r.top < 0 || r.top > innerHeight) continue
      const area = r.width * r.height
      if (area > 40000) continue
      hits.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area: Math.round(area) })
    }
    if (!hits.length) return null
    hits.sort((a, b) => b.area - a.area)
    return hits[0]
  })()`)
}

/** 结算页点「去结算」：点不到就换位置重试，最后再用 DOM click 兜底 */
export async function goCheckout(browser) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = (await pointOfButton(browser, '去结算')) || (await pointOfText(browser, '去结算'))
    if (!point) {
      const bar = await browser.evaluate(`(() => {
        const el = document.querySelector('[class*=cart_bol4dP]')
        return el ? String(el.innerText || '').replace(/\\s+/g, ' ').trim() : ''
      })()`)
      lastError = new Error(`点不了「去结算」，购物车条现在显示：${bar || '（没找到购物车条）'}。多半是没到起送价，再加一样就够。`)
      break
    }
    await browser.clickAt(point.x, point.y, { settleMs: 900 })
    for (let i = 0; i < 10; i += 1) {
      const url = await browser.evaluate('location.href')
      if (url.includes(PREVIEW_PATH)) return url
      const hasPreview = await browser.evaluate(`/提交订单/.test(document.body.innerText)`).catch(() => false)
      if (hasPreview) return url
      await sleep(400)
    }
    // DOM click 兜底（有些按钮只认 React 合成事件上的 onClick）
    await browser
      .evaluate(`(() => {
        const els = [...document.querySelectorAll('div,span,button,a')].filter((el) => /^去结算$/.test(String(el.textContent || '').trim()))
        for (const el of els) { try { el.click() } catch {} }
        return els.length
      })()`)
      .catch(() => {})
    await sleep(1600)
  }
  const url = await browser.evaluate('location.href')
  if (url.includes(PREVIEW_PATH)) return url
  throw (
    lastError ||
    new Error(`点了「去结算」但没进结算页（当前在 ${url}），可能这家店暂时不接单或者购物车里的菜被下架了`)
  )
}

/** 地址选择页：所有地址行 + 是否超配送范围 */
export async function addressRows(browser) {
  return browser.evaluate(`(() => {
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll('div,li,section')) {
      const t = (el.innerText || '').trim()
      if (!/先生|女士/.test(t)) continue
      if (t.length > 140) continue
      const r = el.getBoundingClientRect()
      if (r.width < 200 || r.height < 40 || r.height > 120) continue
      const key = Math.round(r.y) + ':' + t.slice(0, 24)
      if (seen.has(key)) continue
      seen.add(key)
      let outOfRange = false
      for (let p = el; p; p = p.parentElement) {
        if (/outOfRange/.test(String(p.className || ''))) { outOfRange = true; break }
        if (p.className && /page_/.test(String(p.className))) break
      }
      const lines = t.split('\\n').map((line) => line.trim()).filter(Boolean)
      out.push({ address: lines[0], person: (lines[1] || '').slice(0, 20), outOfRange, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    }
    return out
  })()`)
}

/** 在地址列表页 / 弹出面板里按关键词选地址（关键词为空就选第一个「不超范围」的） */
export async function chooseAddress(browser, keyword = '') {
  const rows = await addressRows(browser)
  if (!rows.length) throw new Error('地址列表是空的（面板可能没打开）')
  const usable = rows.filter((row) => !row.outOfRange)
  if (!usable.length) {
    return { ok: false, rows, reason: '这家店不给你任何一个保存的地址配送（全部超配送范围）' }
  }
  const target = keyword
    ? usable.find((row) => row.address.includes(keyword)) || usable.find((row) => keyword.includes(row.address.slice(0, 4)))
    : usable[0]
  if (!target) return { ok: false, rows, reason: `能配送的地址里没有「${keyword}」` }
  await browser.clickAt(target.x, target.y, { settleMs: 700 })
  for (let i = 0; i < 22; i += 1) {
    const url = await browser.evaluate('location.href')
    if (url.includes(PREVIEW_PATH)) return { ok: true, picked: target, rows, url }
    const sheetGone = await browser.evaluate(`!/新增收货地址/.test(document.body.innerText)`).catch(() => false)
    if (sheetGone) {
      await sleep(1200)
      return { ok: true, picked: target, rows, url }
    }
    await sleep(400)
  }
  return { ok: false, picked: target, rows, reason: '点了地址但结算页没更新', url: await browser.evaluate('location.href') }
}

/** 打开地址选择（结算页 → 选择收货地址）：可能是整页路由，也可能是底部弹出面板 */
export async function openAddressPanel(browser) {
  const point =
    (await pointOfText(browser, '选择收货地址', { exact: false })) ||
    (await pointOfText(browser, '填写地址', { exact: false }))
  if (!point) return { ok: false, reason: '结算页上没有「选择收货地址」入口' }
  await browser.clickAt(point.x, point.y, { settleMs: 900 })
  for (let i = 0; i < 20; i += 1) {
    const url = await browser.evaluate('location.href')
    if (url.includes(ADDRESSLIST_PATH)) {
      await sleep(900)
      return { ok: true, mode: 'page', url }
    }
    const sheet = await browser
      .evaluate(`/新增收货地址|地址列表|我的收货地址/.test(document.body.innerText)`)
      .catch(() => false)
    if (sheet) {
      await sleep(1000)
      return { ok: true, mode: 'sheet', url }
    }
    await sleep(400)
  }
  return { ok: false, reason: '点「选择收货地址」后既没跳页也没弹面板', url: await browser.evaluate('location.href') }
}

/** 选餐具（结算页必选项） */
export async function chooseTableware(browser, preference = '无需餐具') {
  const row = await browser.evaluate(`(() => {
    for (const el of document.querySelectorAll('div,span')) {
      const t = (el.textContent || '').trim()
      if (!/餐具/.test(t) || t.length > 24) continue
      const r = el.getBoundingClientRect()
      if (r.width < 40 || r.height < 12) continue
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }
    return null
  })()`)
  if (!row) return { ok: false, reason: '没找到餐具那一行' }
  await browser.clickAt(row.x, row.y, { settleMs: 700 })
  const options = await browser.evaluate(`(() => {
    const out = []
    for (const el of document.querySelectorAll('div,span,li')) {
      const t = (el.textContent || '').trim()
      if (!/无需餐具|份餐具|\\d份/.test(t) || t.length > 12) continue
      const r = el.getBoundingClientRect()
      if (r.width < 30 || r.height < 14) continue
      out.push({ text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    }
    return out
  })()`)
  if (!options.length) return { ok: false, reason: '点了餐具行但没看到选项' }
  const target = options.find((option) => option.text.includes(preference)) || options[0]
  await browser.clickAt(target.x, target.y, { settleMs: 700 })
  await sleep(600)
  return { ok: true, picked: target.text, options: options.map((option) => option.text) }
}

/** 点「提交订单」（调用方必须先确认用户同意） */
export async function submitOrder(browser) {
  const point = await pointOfText(browser, '提交订单')
  if (!point) throw new Error('没找到「提交订单」按钮')
  await browser.clickAt(point.x, point.y, { settleMs: 800 })
  for (let i = 0; i < 30; i += 1) {
    const url = await browser.evaluate('location.href')
    if (!url.includes(PREVIEW_PATH)) {
      await sleep(1200)
      return { url, text: (await text(browser, 800)) }
    }
    await sleep(500)
  }
  return { url: await browser.evaluate('location.href'), text: (await text(browser, 800)) }
}

/** 首页顶部当前配送地址文案 */
export async function currentDeliveryText(browser) {
  return browser.evaluate(`(() => {
    const el = document.querySelector('[class*=ellipsis]')
    const t = el ? (el.innerText || '').trim() : ''
    return t || (document.body.innerText.split('\\n')[0] || '')
  })()`)
}

/** 首页 → 地址选择器 → 选一个「我的收货地址」（决定 AOI：能看到哪一片的店） */
export async function switchDeliveryAddress(browser, keyword) {
  await browser.goto('https://h5.waimai.meituan.com/waimai/mindex/home', { settleMs: 2200 })
  await sleep(1200)
  const before = await currentDeliveryText(browser)
  const entry = await browser.evaluate(`(() => {
    const el = document.querySelector('[class*=ellipsis]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (el.innerText || '').trim() }
  })()`)
  if (!entry) return { ok: false, reason: '首页顶部没找到地址入口', before }
  await browser.clickAt(entry.x, entry.y, { settleMs: 600 })
  for (let i = 0; i < 20; i += 1) {
    const url = await browser.evaluate('location.href')
    if (url.includes(POIPICKER_PATH)) break
    await sleep(400)
  }
  await sleep(1200)
  const rows = await browser.evaluate(`(() => {
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll('div,li,section')) {
      const t = (el.innerText || '').trim()
      if (!/先生|女士/.test(t)) continue
      if (t.length > 140) continue
      const r = el.getBoundingClientRect()
      if (r.width < 200 || r.height < 40 || r.height > 120) continue
      const key = Math.round(r.y) + ':' + t.slice(0, 24)
      if (seen.has(key)) continue
      seen.add(key)
      const lines = t.split('\\n').map((line) => line.trim()).filter(Boolean)
      out.push({ address: lines[0], person: (lines[1] || '').slice(0, 20), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    }
    return out
  })()`)
  const target = keyword ? rows.find((row) => row.address.includes(keyword)) : rows[0]
  if (!target) return { ok: false, before, rows, reason: keyword ? `收货地址里没有「${keyword}」` : '收货地址是空的' }
  await browser.clickAt(target.x, target.y, { settleMs: 800 })
  for (let i = 0; i < 25; i += 1) {
    const url = await browser.evaluate('location.href')
    if (url.includes('/waimai/mindex/home')) break
    await sleep(400)
  }
  await sleep(1800)
  const after = await currentDeliveryText(browser)
  return { ok: true, before, after, picked: target, rows }
}
