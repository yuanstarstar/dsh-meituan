// 美团外卖 h5 菜单页的购物车操作：加菜、看车、清空
// 只动购物车，绝不点「去结算 / 提交订单」——那已经不是「放购物车里」了
import { sleep } from './util.js'

const ADD_BTN = '.sqt-menu-add-buttons'
const CART_ICON = '[aria-label="购物车"]'

/** 把菜名/店名做宽松归一化，方便模糊匹配 */
function norm(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[()（）【】[\]·,，.。:：、!！?？"“”'’]/g, '')
    .toLowerCase()
}

function score(rowName, target) {
  const a = norm(rowName)
  const b = norm(target)
  if (!a || !b) return 0
  if (a === b) return 100
  if (a.includes(b) || b.includes(a)) return 70
  let hit = 0
  for (const ch of b) if (a.includes(ch)) hit += 1
  return Math.round((hit / b.length) * 40)
}

/** 读底部购物车条：几件、多少钱 */
export async function cartState(browser) {
  const raw = await browser.evaluate(`(() => {
    const bar = document.querySelector('[class*=cart_bol4dP]')
    const mark = document.querySelector('[class*=cornerMark]')
    const amount = document.querySelector('[class*=payableAmount_mk0I3q]') || document.querySelector('[class*=payableAmount]')
    return {
      hasBar: Boolean(bar),
      text: bar ? String(bar.innerText || '').replace(/\\n/g, ' ').replace(/\\s+/g, ' ').trim() : '',
      mark: mark ? String(mark.textContent || '').trim() : '',
      amount: amount ? String(amount.textContent || '').trim() : '',
      shop: String(document.title || '').trim(),
      href: location.href,
    }
  })()`)
  const count = Number.parseInt(raw.mark, 10)
  const total = Number.parseFloat(String(raw.amount).replace(/[^\d.]/g, ''))
  return {
    shop: raw.shop,
    href: raw.href,
    hasBar: raw.hasBar,
    count: Number.isFinite(count) ? count : 0,
    total: Number.isFinite(total) ? total : 0,
    text: raw.text,
  }
}

/** 列出菜单页上每一行菜（含加号按钮的位置） */
export async function dishRows(browser, target = '') {
  const rows = await browser.evaluate(`(() => {
    const norm = (s) => String(s || '').replace(/\\s+/g, '').replace(/[()（）【】\\[\\]·,，.。:：、!！?？"“”'’]/g, '').toLowerCase()
    const out = []
    const btns = [...document.querySelectorAll(${JSON.stringify(ADD_BTN)})]
    btns.forEach((btn, i) => {
      // 菜名在 .infoTop_* 的第一行；老结构里靠往上找「首行不像价格」的多行祖先兜底
      let name = ''
      const top = btn.closest('[class*=infoTop]')
      if (top) {
        name = String(top.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)[0] || ''
      }
      if (!name) {
        let node = btn
        for (let d = 0; d < 6 && node; d += 1) {
          node = node.parentElement
          if (!node) break
          const lines = String(node.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)
          if (lines.length >= 2 && lines[0].length >= 2 && !/^[¥￥\\d.\\s]+$/.test(lines[0])) {
            name = lines[0]
            break
          }
        }
      }
      if (!name) return
      // 这些不是菜名（活动标签、售罄提示、分类标题之类）
      if (/已送完|已售完|售罄|公告|^热销$|^评价$|^搜索$|^商家$|^点菜$|^进店|^新品推荐$/.test(name)) return
      out.push({ i, name, hasPlus: Boolean(btn.querySelector('span[class*=plus]')), disabled: /disabled|soldout|售罄/i.test(String(btn.className || '')) })
    })
    return out
  })()`)
  const list = Array.isArray(rows) ? rows : []
  const scored = list.map((row) => ({ ...row, score: score(row.name, target) }))
  scored.sort((a, b) => b.score - a.score)
  return scored
}

/** 把第 i 个加号按钮滚进视口（并避开底部购物车条），返回可以点的屏幕坐标 + 是否真能点到 */
async function addButtonPoint(browser, index) {
  return browser.evaluate(`(() => {
    const btn = [...document.querySelectorAll(${JSON.stringify(ADD_BTN)})][${index}]
    if (!btn) return null
    btn.scrollIntoView({ block: 'center' })
    const measure = () => {
      const inner = btn.querySelector('span[class*=plus]') || btn
      const r = inner.getBoundingClientRect()
      if (!r.width || !r.height) return { zero: true }
      const x = Math.round(r.x + r.width / 2)
      const y = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      const ok = Boolean(hit && (hit === inner || inner.contains(hit) || (hit.closest && hit.closest('.sqt-menu-add-buttons') === btn)))
      return { x, y, ok, hit: hit ? String(hit.className || hit.tagName || '').slice(0, 40) : '' }
    }
    let point = measure()
    if (!point || point.zero) return point
    // 太低会被底部购物车条盖住 → 往上滚一点再量
    if (!point.ok || point.y > innerHeight - 96) {
      window.scrollBy(0, point.y - (innerHeight - 170))
      point = measure()
    }
    return point
  })()`)
}

/** 规格弹窗里那个「加入购物车」按钮 */
async function specConfirmPoint(browser) {
  return browser.evaluate(`(() => {
    const hits = [...document.querySelectorAll('div,span,button,a')].filter(
      (el) => el.childElementCount <= 1 && /^加入购物车$/.test(String(el.textContent || '').trim()),
    )
    if (!hits.length) return null
    const el = hits[hits.length - 1]
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
}

async function specSheetText(browser) {
  return browser.evaluate(`(() => {
    const box = [...document.querySelectorAll('div')].filter((el) => /加入购物车/.test(String(el.innerText || '')) && String(el.innerText || '').length < 400)
    return box.length ? String(box[box.length - 1].innerText || '').replace(/\\n/g, ' | ').slice(0, 260) : ''
  })()`)
}

/** 加一道菜（自动处理多规格弹窗：用默认规格） */
export async function addDish(browser, name, { times = 1 } = {}) {
  // 每次加菜都回到菜单顶部再找，避免上次滚动的位置把上面的菜漏掉
  await browser
    .evaluate(`(() => {
      window.scrollTo(0, 0)
      for (const el of document.querySelectorAll('div,section,ul')) {
        const style = getComputedStyle(el)
        if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight - el.clientHeight > 80 && el.clientHeight > 200) el.scrollTop = 0
      }
      return true
    })()`)
    .catch(() => {})
  await sleep(320)
  let rows = await dishRows(browser, name)
  let best = rows[0]
  // 这道菜可能在下面的分类里（页面只渲染附近的行）→ 一边滚动菜单容器一边找
  for (let step = 0; step < 16 && (!best || best.score < 60); step += 1) {
    const moved = await browser
      .evaluate(`(() => {
        const boxes = [...document.querySelectorAll('div,section,ul')].filter((el) => {
          const style = getComputedStyle(el)
          return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight - el.clientHeight > 80 && el.clientHeight > 200
        })
        boxes.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)
        const box = boxes[0]
        if (box) {
          const before = box.scrollTop
          box.scrollTop = before + 520
          if (box.scrollTop !== before) return true
        }
        const top = window.scrollY
        window.scrollBy(0, 520)
        return window.scrollY !== top
      })()`)
      .catch(() => false)
    if (!moved) break
    await sleep(430)
    rows = await dishRows(browser, name)
    best = rows[0]
  }
  if (!best || best.score < 40) {
    return {
      ok: false,
      name,
      reason: '菜单里没找到这道菜',
      candidates: rows.map((r) => r.name).filter(Boolean).slice(0, 12),
    }
  }
  let added = 0
  for (let n = 0; n < times; n += 1) {
    const before = await cartState(browser)
    let point = await addButtonPoint(browser, best.i)
    // 加号可能被 toast/公告浮层临时盖住 → 等一会儿再量，最多试 5 次
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!point) return { ok: false, name, reason: '页面上找不到加号按钮' }
      if (point.zero) {
        await sleep(500)
        point = await addButtonPoint(browser, best.i)
        continue
      }
      if (point.ok !== false) break
      await sleep(900)
      await browser.evaluate('window.scrollBy(0, -80)').catch(() => {})
      await sleep(200)
      point = await addButtonPoint(browser, best.i)
    }
    if (!point || point.zero) return { ok: false, name, reason: '加号按钮滚不进视口' }
    if (point.ok === false) {
      return { ok: false, name, reason: `加号一直被「${point.hit || '别的元素'}」盖住，没点进去` }
    }
    await sleep(320)
    await browser.clickAt(point.x, point.y)
    await sleep(1100)
    const confirm = await specConfirmPoint(browser)
    if (confirm) {
      await browser.clickAt(confirm.x, confirm.y)
      await sleep(1300)
    }
    const after = await cartState(browser)
    if (after.count > before.count || (after.count === before.count && after.total > before.total)) added += 1
    else {
      const sheet = await specSheetText(browser)
      return {
        ok: added > 0,
        name: best.name,
        added,
        reason: sheet ? `规格没选全？（弹窗：${sheet}）` : '点了加号但购物车没变',
        sheet,
      }
    }
  }
  return { ok: true, name: best.name, added, matched: best.name, score: best.score }
}

/** 打开购物车面板并读里面有什么 */
export async function readCart(browser) {
  const state = await cartState(browser)
  if (!state.count) return { ...state, items: [], open: false }
  const icon = await browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(CART_ICON)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!icon) return { ...state, items: [], open: false }
  await browser.clickAt(icon.x, icon.y)
  await sleep(1200)
  const items = await browser.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[class*=cartItem]')]
    return rows.map((el) => String(el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean))
  })()`)
  return { ...state, items: Array.isArray(items) ? items : [], open: true }
}

/** 清空当前这家店的购物车 */
export async function clearCart(browser) {
  const before = await cartState(browser)
  if (!before.count) return { ok: true, alreadyEmpty: true, cart: before }
  const icon = await browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(CART_ICON)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (icon) {
    await browser.clickAt(icon.x, icon.y)
    await sleep(1200)
  }
  const clear = await browser.evaluate(`(() => {
    const hits = [...document.querySelectorAll('div,span,button,a')].filter((el) => /^(清空购物车|清空)$/.test(String(el.textContent || '').trim()))
    if (!hits.length) return null
    const el = hits[hits.length - 1]
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!clear) return { ok: false, reason: '没找到「清空购物车」按钮', cart: before }
  await browser.clickAt(clear.x, clear.y)
  await sleep(1400)
  const after = await cartState(browser)
  return { ok: !after.count, before, cart: after }
}
