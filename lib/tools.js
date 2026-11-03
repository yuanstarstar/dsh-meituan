import fs from 'node:fs'
import path from 'node:path'
import { clip } from './util.js'
import { qrPng } from './qr.js'

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      // schema 声明 object 就必须真返回 object（历史坑：声明 object 返回 string 会被判 invalid output）
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: true,
      },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : String(value?.text ?? JSON.stringify(value, null, 2)) },
      ],
    },
    execute: async (args) => {
      const value = await execute(args)
      if (value && typeof value === 'object') return value
      return { text: String(value ?? '') }
    },
  }
}

function fail(message) {
  return { text: `❌ ${message}` }
}

const TASTE_FIELDS = `
口味档案这些字段会用来给店排序：
- likes：爱吃什么（数组，如 ["川菜","面条","鸡肉"]）
- dislikes：不吃的 / 讨厌的（数组，如 ["香菜","太油"]）
- spicy：吃辣程度 0~3（0 不吃辣，3 无辣不欢）
- budget：一顿想花多少钱（人均，元）
- health：是否在控卡减脂（true/false）
- note：自由补充（比如「最近想吃清淡的」「别老是那几家」）`.trim()

export function registerTools(ctx, { store, meituan, jd }) {
  const register = (definition, label) =>
    ctx.effect(
      () =>
        ctx.tools.register({
          ...definition,
          execute: async (args) => {
            const value = await definition.execute(args)
            // 这一轮如果被迫弹过验证窗口，顺手在结果末尾提一句
            const note = typeof meituan.takeVerifyNote === 'function' ? meituan.takeVerifyNote() : ''
            if (!note) return value
            const object = value && typeof value === 'object' ? value : { text: String(value ?? '') }
            const text = String(object.text ?? '')
            return { ...object, text: text ? `${text}\n${note}` : note }
          },
        }),
      label,
    )

  register(
    tool(
      'meituan_login',
      [
        '美团外卖登录（手机号 + 短信验证码）。用户说「登录美团 / 帮我登一下美团外卖」时用。',
        '',
        '分两步，必须按顺序：',
        '1) action:"send"，带上用户给的 phone（11 位手机号）→ 美团会给这个号发短信验证码；然后问用户要验证码。',
        '2) action:"verify"，带上用户刚给你的 code → 登录，成功后浏览器资料目录会存下来，以后不用再登。',
        '',
        'action:"status" 查当前登录状态（不打开发短信流程）；action:"logout" 退出并清掉本机登录痕迹。',
        '只有「进店铺看菜单 / 搜索 / 看自己地址和订单」才必须登录；看附近商家列表不用登录。',
        '如果 verify 一直失败（风控、滑块、验证码过期），让用户去设置页「美团外卖」把「显示浏览器窗口」打开，肉眼看一下登录页。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'send', 'verify', 'logout'], description: '要做什么；默认 status' },
          phone: { type: 'string', description: 'action="send" 时必填：11 位手机号' },
          code: { type: 'string', description: 'action="verify" 时必填：用户收到的短信验证码' },
        },
        additionalProperties: false,
      },
      async ({ action = 'status', phone, code } = {}) => {
        try {
          if (action === 'send') {
            if (!phone) return fail('要发验证码得先有手机号：问用户要 11 位手机号，再用 phone 传给我')
            const result = await meituan.loginStart(phone)
            return {
              text: [
                `已把「${result.phone}」填进美团登录页${result.clicked ? '并点了发送验证码' : '，但「发送验证码」按钮没点到'}`,
                '',
                '看下手机短信，把 4~6 位验证码告诉我，我再调 meituan_login action:"verify" 提交。',
                `（页面当前提示：${result.pageText}）`,
              ].join('\n'),
              phone: result.phone,
              clicked: result.clicked,
            }
          }
          if (action === 'verify') {
            if (!code) return fail('把用户收到的短信验证码用 code 传给我')
            const result = await meituan.loginVerify(code)
            return {
              text: result.ok ? `✅ 美团登录成功。${result.hint}` : `❌ 没登进去：${result.hint}\n（当前页面 ${result.url}）`,
              ok: result.ok,
              url: result.url,
            }
          }
          if (action === 'logout') {
            await meituan.logout()
            return { text: '已退出美团登录，本机的浏览器登录资料也删了。' }
          }
          const status = await meituan.status({ deep: true })
          if (status.error) return fail(`查登录状态出错了：${status.error}`)
          return {
            text: status.loggedIn
              ? `已登录美团外卖${status.phone ? `（手机号 ${String(status.phone).slice(0, 3)}****${String(status.phone).slice(-4)}）` : ''}`
              : '还没登录美团外卖。要登录的话，把手机号给我，我发验证码。',
            loggedIn: status.loggedIn,
            phone: status.phone || '',
          }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'meituan: login',
  )

  register(
    tool(
      'meituan_pick',
      [
        '【核心工具】没主意吃什么的时候用它：由美团外卖那边拉一批候选商家（附近或按关键词搜），结合用户的口味档案打分排序，返回前几名和**可直接打开的美团分享链接**。',
        '',
        '典型用法：用户说「今天不知道吃什么」→ 先 meituan_taste 看口味（或直接调本工具，它会自动带上档案）→ 调本工具拿候选 → 你从候选中挑 1~3 家，用中文说清「为什么是它」，并把 shareUrl 原样贴给用户。',
        '用户说想吃某个东西（「想吃面」「来点辣的」「整点轻食」）→ keyword 传那个词（中文，豆包那么短就行，别一次塞多个）。',
        '',
        '返回里的 candidates 是结构化的（评分/配送时间/距离/人均/标签/理由/风险/链接），text 是排好序的现成文案；你可以直接用 text，也可以按自己的判断重写，但**链接必须原样用 shareUrl**，不要自己拼。',
        '口味偏好靠 meituan_taste 维护；用户聊到新喜好（「我不吃香菜」「以后别给我推螺蛳粉」）记得顺手写进档案。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '想吃的东西，如「牛肉面」「炸鸡」「轻食」；不填就是按附近商家挑' },
          budget: { type: 'number', description: '这顿的人均预算（元）；不填用口味档案里的' },
          count: { type: 'number', description: '给几家候选，默认 3，最多 10' },
          limit: { type: 'number', description: '从多少家里挑，默认按设置（12），最多 40' },
        },
        additionalProperties: false,
      },
      async ({ keyword = '', budget, count, limit } = {}) => {
        try {
          const result = await meituan.pick({ keyword, budget, count, limit })
          return { text: result.text, candidates: result.candidates, others: result.others, taste: result.taste }
        } catch (error) {
          const message = clip(error?.message || error, 300)
          if (/登录/.test(message)) {
            return fail(`${message}\n\n下一步：把手机号给用户要一下，用 meituan_login 发验证码。`)
          }
          return fail(message)
        }
      },
    ),
    'meituan: pick',
  )

  register(
    tool(
      'meituan_shops',
      '拉美团外卖的商家列表（附近或按关键词搜），返回原始结构化数据：名字、评分、配送时间、距离、起送价、人均、月售、标签、分享链接。不排序、不挑，适合用户想自己看看附近有什么的时候。想「帮他决定」用 meituan_pick。',
      {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索词；不填就是首页附近商家' },
          limit: { type: 'number', description: '最多返回几家，默认按设置（12）' },
        },
        additionalProperties: false,
      },
      async ({ keyword = '', limit } = {}) => {
        try {
          const { shops, total } = await meituan.listShops({ keyword, limit })
          if (!shops.length) return fail('没拿到商家：可能定位没出来，或被要求登录')
          const lines = shops.map((shop, index) => {
            const bits = [shop.score ? `${shop.score}分` : '', shop.deliveryTip, shop.distance].filter(Boolean).join(' · ')
            const price = [shop.avgPrice ? `人均 ¥${shop.avgPrice}` : '', shop.minPrice ? `起送 ¥${shop.minPrice}` : '', shop.monthSalesText]
              .filter(Boolean)
              .join(' · ')
            return `${index + 1}. ${shop.name}  ${bits}\n   ${price}${shop.tags.length ? `\n   标签：${shop.tags.join(' / ')}` : ''}\n   ${shop.shareUrl}${shop.id ? `\n   id：${shop.id}` : ''}`
          })
          return {
            text: `${keyword ? `搜「${keyword}」` : '附近商家'}：拿到 ${total} 家，显示 ${shops.length} 家\n\n${lines.join('\n')}`,
            shops,
          }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'meituan: shops',
  )

  register(
    tool(
      'meituan_menu',
      '打开某家店的菜单，把菜品和价格读回来（需要已登录）。用户问「这家有什么好吃的」「帮我在这家点一个」时用。可以给 id（poi_id_str），也可以只给店名，会先去附近列表里找。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: '商家的 poi_id_str（meituan_pick / meituan_shops 返回里的 id 字段）' },
          name: { type: 'string', description: '店名（没 id 时用，模糊匹配）' },
        },
        additionalProperties: false,
      },
      async ({ id, name } = {}) => {
        try {
          const result = await meituan.menu({ id, name })
          const lines = []
          const head = `【${result.shop.name || name || id}】${result.shop.score ? ` ${result.shop.score}分` : ''}${result.shop.deliveryTip ? ` · ${result.shop.deliveryTip}` : ''}${result.shop.distance ? ` · ${result.shop.distance}` : ''}`
          lines.push(head)
          if (result.dishes.length) {
            lines.push('', `菜品（${result.dishes.length} 个）：`)
            for (const dish of result.dishes.slice(0, 40)) {
              lines.push(`- ${dish.name}  ¥${dish.price}${dish.sales ? `  · 月售 ${dish.sales}` : ''}`)
            }
          } else if (result.pageText) {
            lines.push('', '菜单页文字（没解析出结构化菜品，直接给原文）：', clip(result.pageText, 1800))
          } else {
            lines.push('', '没读到菜单内容：可能没登录，或这家店页面结构不同。')
          }
          if (result.shop.shareUrl) lines.push('', result.shop.shareUrl)
          if (result.shop.id) lines.push(`id：${result.shop.id}（出点菜方案/加车深链要用这个）`)
          return { text: lines.join('\n'), shop: result.shop, dishes: result.dishes }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'meituan: menu',
  )

  register(
    tool(
      'meituan_cart',
      [
        '把「这一单想吃的菜」整理成点菜方案：每道菜的 **App 深链**（手机点开直接落到这道菜，一格加车）+ 网页菜单链接 + 合计。**不会下单，也不会付款。**',
        '为什么不是直接加车：美团网页端的购物车只存在浏览器本地（实测点加号只发一个算价请求，数据在 localStorage 的 cached_cart_data 里），换浏览器就没了，手机上的美团 App 也看不到。所以这里不假装帮你加车，而是把你送到 App 里那道菜上。',
        '典型用法：先 meituan_menu 看这家有什么菜 → 用户说「来个牛肉面再加个肉夹馍」→ 传同一家店的 shopId（或 shopName）+ dishes。',
        'action:"plan"（默认）出方案；action:"view" / "clear" 只对插件自己那个浏览器里的购物车有效（自检用，App 看不到）。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['plan', 'view', 'clear'], description: 'plan 出点菜方案（默认）/ view 看插件浏览器里的车 / clear 清空它' },
          shopId: { type: 'string', description: '店铺 poi_id_str（meituan_pick / meituan_shops / meituan_menu 返回里的 id）' },
          shopName: { type: 'string', description: '没 shopId 时用店名，会先搜索找到这家店' },
          dishes: { type: 'array', items: { type: 'string' }, description: '想点的菜名，可模糊（「牛肉面」「肉夹馍」）' },
          qty: { type: 'number', description: '每样几份，默认 1' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async ({ action = 'plan', shopId, shopName, dishes, qty } = {}) => {
        try {
          const result = await meituan.cart({ action, shopId, shopName, dishes, qty })
          const lines = [`【${result.shop.name}】`]
          if (result.shop.id) lines.push(`id：${result.shop.id}`)

          if (result.action === 'plan') {
            const items = result.items || []
            if (items.length) {
              lines.push('', `点了 ${items.length} 样，合计 ¥${result.total}（菜单价，不含配送费和红包）：`)
              const qrDir = path.join(store.dir, 'qr')
            const qrFiles = []
            items.forEach((item, index) => {
                const count = item.qty > 1 ? ` ×${item.qty}` : ''
                const price = item.price != null ? ` ¥${item.price}${count}` : ''
                const subtotal = item.qty > 1 && item.subtotal != null ? `（小计 ¥${item.subtotal}）` : ''
                lines.push(`${index + 1}. ${item.name}${price}${subtotal}`)
                if (item.appLink) lines.push(`   手机点开直达这道菜：${item.appLink}`)
                if (item.appLink) {
                  try {
                    fs.mkdirSync(qrDir, { recursive: true })
                    const file = path.join(qrDir, `dish-${item.spuId || index + 1}.png`)
                    fs.writeFileSync(file, qrPng(item.appLink))
                    item.qr = file
                    qrFiles.push(file)
                    lines.push(`   二维码图片：${file}`)
                  } catch (error) {
                    lines.push(`   二维码没生成：${clip(error?.message || error, 80)}`)
                  }
                }
                if (item.webLink) lines.push(`   电脑上看菜单：${item.webLink}`)
              })
            } else if ((result.menu || []).length) {
              lines.push('', '这次没指定菜，先给你菜单（说一句我就出方案）：')
              for (const dish of result.menu.slice(0, 25)) lines.push(`- ${dish.name}${dish.price != null ? ` ¥${dish.price}` : ''}`)
            }
            if ((result.missing || []).length) {
              lines.push('', `这几样菜单里没找到：${result.missing.join(' / ')}（换个说法，或先 meituan_menu 看准确菜名）`)
            }
            lines.push('', '说明：网页购物车是浏览器本地缓存，你手机上的美团 App 看不到它（不是 bug）。把上面 meituanwaimai:// 的链接发到手机上点开，或直接扫二维码，会进 App 里这道菜，点一下「加入购物车」就进你自己的车了。')
            if (result.url) lines.push(`网页菜单（电脑能打开）：${result.url}`)
            return { text: lines.join('\n'), shop: result.shop, items, total: result.total, missing: result.missing, qrFiles }
          }

          const cart = result.cart || {}
          lines.push('', `插件浏览器里的购物车：${cart.count || 0} 件${cart.total ? ` · 实付 ¥${cart.total}` : ''}`)
          if (result.action === 'view') {
            const rows = cart.items || []
            if (rows.length) {
              lines.push('', '车里这些：')
              for (const row of rows.slice(0, 20)) lines.push(`- ${row.filter(Boolean).join(' ')}`)
            }
          } else {
            lines.push('', result.ok ? '已清空（只清了插件这个浏览器里的车，App 里本来就没有）。' : `没清干净，还有 ${cart.count || 0} 件。`)
          }
          return { text: lines.join('\n'), shop: result.shop, cart }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'meituan: cart',
  )

  register(
    tool(
      'meituan_order',
      [
        '在电脑上真下单：把菜加进购物车 → 进结算页 → 选配送地址 →（你同意后）提交订单。**这里是真金白银，submit 必须你自己点头。**',
        'action:"address" 只切「配送地址」（决定首页能看到哪一片的店、能不能送到）；传 address 关键词（如「公司」「家」），不传就选第一个。',
        'action:"prepare"（默认）把 dishes 加进购物车并停在结算页，读回地址/费用/合计/餐具，**不提交**。',
        'action:"open" 切到可见窗口、停在结算页，让你自己核对并点提交（推荐，付款这步始终由你亲手完成）。',
        'action:"submit" 真的点「提交订单」，必须同时传 confirm:true；不给 confirm 会直接拒绝。',
        '菜名可模糊（「牛肉面」「肉夹馍」）；加车只影响插件自己这个浏览器，但结算页是真实的，提交后就是真实订单。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['prepare', 'address', 'open', 'submit'], description: 'prepare 准备到结算页（默认）/ address 切配送地址 / open 可见窗口自己点 / submit 提交（需 confirm:true）' },
          shopId: { type: 'string', description: '店铺 poi_id_str' },
          shopName: { type: 'string', description: '没 shopId 时用店名' },
          dishes: { type: 'array', items: { type: 'string' }, description: '要点的菜名（可模糊）' },
          qty: { type: 'number', description: '每样几份，默认 1' },
          address: { type: 'string', description: '收货地址关键词（如「公司」「家」）；不传就用第一个能送的' },
          confirm: { type: 'boolean', description: 'submit 必须为 true，表示你确认真的下单' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async ({ action = 'prepare', shopId, shopName, dishes, qty, address, confirm } = {}) => {
        try {
          const result = await meituan.order({ action, shopId, shopName, dishes, qty, address, confirm })
          if (result.action === 'address') {
            if (!result.ok) {
              const rows = (result.rows || []).map((row) => `- ${row.address}（${row.person}）`).join('\n')
              return fail(`${result.reason || '切地址失败'}${rows ? `\n能选的收货地址：\n${rows}` : ''}`)
            }
            return {
              text: [`配送地址：${result.after || result.picked?.address || ''}`, `（原来是「${result.before || ''}」）`, '', '首页现在只会显示能送到这个地址的店。'].join('\n'),
              address: result.after,
              rows: result.rows,
            }
          }

          const shop = result.shop || {}
          const lines = [`【${shop.name || shop.id}】`]
          if (shop.id) lines.push(`id：${shop.id}`)
          if ((result.added || []).length) lines.push('', `已放进插件浏览器的购物车：${result.added.join(' / ')}`)
          if ((result.failed || []).length) {
            lines.push('', '这几样没加成：')
            for (const item of result.failed) {
              const tips = (item.candidates || []).length ? `（菜单里相近的：${item.candidates.join(' / ')}）` : ''
              lines.push(`- ${item.name}：${item.reason}${tips}`)
            }
          }
          const preview = result.preview || {}
          if (preview.url) {
            lines.push('', `结算页：${preview.url}`)
            if (preview.address) lines.push(`收货地址：${preview.address}`)
            if (preview.total) lines.push(`合计：¥${preview.total}`)
            if (preview.tableware) lines.push(`餐具：${preview.tableware.replace(/\s+/g, ' ')}`)
            if (preview.addressNote) lines.push(`地址提示：${preview.addressNote}`)
            if (result.tableware && result.tableware.ok === false) {
              lines.push(`餐具没自动选上（${result.tableware.reason || '没看到选项'}）——提交前得在窗口里手动选一下`)
            }
          }
          if (result.reason) lines.push('', result.reason)
          if (result.note) lines.push('', result.note)
          if (result.submitted) {
            lines.push('', `已提交：${result.result?.url || ''}`)
            lines.push(clip(result.result?.text || '', 600))
          } else if (result.action === 'prepare') {
            lines.push('', '还没提交。要么说「就这单，提交」我再点提交订单（会真下单），要么说「打开窗口自己点」我切到可见窗口让你付款。')
          }
          return { text: lines.join('\n'), shop: result.shop, preview: result.preview, added: result.added, failed: result.failed }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'meituan: order',
  )

  register(
    tool(
      'meituan_taste',
      [
        '用户的口味档案：读/改。挑外卖前先读一次，聊到新喜好时顺手写进去。',
        TASTE_FIELDS,
        '',
        'action:"get" 读当前档案；action:"set" 只传要改的字段（其余保持不变）。likes/dislikes 传数组（会整体替换）。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: '默认 get' },
          likes: { type: 'array', items: { type: 'string' }, description: '爱吃什么' },
          dislikes: { type: 'array', items: { type: 'string' }, description: '不吃的' },
          spicy: { type: 'number', description: '吃辣程度 0~3' },
          budget: { type: 'number', description: '人均预算（元）' },
          health: { type: 'boolean', description: '是否控卡减脂' },
          note: { type: 'string', description: '自由补充' },
        },
        additionalProperties: false,
      },
      async ({ action = 'get', ...patch } = {}) => {
        if (action === 'set') {
          const clean = {}
          for (const key of ['likes', 'dislikes', 'spicy', 'budget', 'health', 'note']) {
            if (patch[key] !== undefined) clean[key] = patch[key]
          }
          const taste = store.setTaste(clean)
          return { text: `已更新口味档案：\n${renderTaste(taste)}`, taste }
        }
        const taste = store.getTaste()
        return { text: `当前口味档案：\n${renderTaste(taste)}`, taste }
      },
    ),
    'meituan: taste',
  )

  // ---------------- 京东外卖（小时达 / 秒送） ----------------
  register(
    tool(
      'jd_pick',
      [
        '按用户口味从京东外卖（小时达/秒送）里挑几家，给理由 + 推荐菜 + 能直接打开的链接。',
        '“不知道吃什么”时的首选：只开一次京东频道页（跟人点一下一样），读页面自己发的数据，不伪造请求、不自己签名。',
        '',
        '需要用户 Edge 里装着并启用「DSH 点餐桥」扩展；没连上会报错，提醒用户把扩展打开。',
        '挑完把每家的「链接」原样发给用户——点开就是这家店，能直接下单。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '想吃的东西，可空（例如「牛肉面」「麻辣烫」）' },
          count: { type: 'number', description: '推荐几家，默认 3' },
          limit: { type: 'number', description: '候选池大小，默认 12' },
          budget: { type: 'number', description: '人均预算（元）；不传用口味档案里的' },
          qr: { type: 'boolean', description: 'true = 顺带给每家店的二维码图片路径（手机扫）' },
          fresh: { type: 'boolean', description: 'true = 强制重新读京东；默认 5 分钟内用缓存' },
        },
        additionalProperties: false,
      },
      async ({ keyword = '', count = 3, limit = 12, budget = 0, qr = false, fresh = false } = {}) => {
        try {
          const taste = store.getTaste()
          const result = await jd.pick({ count, keyword, limit, budget, taste, fresh })
          const lines = []
          lines.push(
            `京东外卖 · 附近 ${result.total} 家${result.cached ? '（用刚读到的，5 分钟内有效）' : ''}${keyword ? ` · 关键词「${keyword}」` : ''}`,
          )
          const qrFiles = []
          result.picked.forEach((shop, index) => {
            lines.push('')
            lines.push(`${index + 1}. 【${shop.name}】${shop.score} 分${shop.distance ? ` · ${shop.distance}` : ''}${shop.eta ? ` · ${shop.eta}` : ''}`)
            if (shop.minPrice || shop.freight || shop.coupons?.length) {
              const bits = []
              if (shop.minPrice) bits.push(`起送 ¥${shop.minPrice}`)
              if (shop.freight) bits.push(`配送 ${shop.freight}`)
              if (shop.coupons?.length) bits.push(shop.coupons.join(' / '))
              lines.push(`   ${bits.join(' · ')}`)
            }
            if (shop.why?.length) lines.push(`   为什么：${shop.why.join('；')}`)
            const dishes = (shop.suggestions || []).filter((dish) => dish.price > 0).slice(0, 3)
            if (dishes.length) lines.push(`   可以点：${dishes.map((dish) => `${dish.name} ¥${dish.price}`).join(' / ')}`)
            lines.push(`   链接：${shop.url}`)
            lines.push(`   id：${shop.id}`)
            if (qr && shop.url) {
              try {
                const file = path.join(store.dir, 'qr', `jd-${shop.id}.png`)
                fs.mkdirSync(path.dirname(file), { recursive: true })
                fs.writeFileSync(file, qrPng(shop.url))
                qrFiles.push(file)
                lines.push(`   二维码：${file}`)
              } catch (error) {
                lines.push(`   二维码没生成：${error?.message || error}`)
              }
            }
          })
          const rest = result.candidates.slice(result.picked.length, result.picked.length + 6)
          if (rest.length) {
            lines.push('')
            lines.push(`其它候选：${rest.map((shop) => shop.name).join(' / ')}`)
          }
          return { text: lines.join('\n'), picked: result.picked, total: result.total, qrFiles }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'jd: pick',
  )

  register(
    tool(
      'jd_menu',
      [
        '看京东外卖某家店的菜单（菜名 + 价格）。',
        '优先用 jd_pick 读到的缓存；缓存里没有就打开这家店读一次。storeId 或店名给一个就行。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          storeId: { type: 'string', description: 'jd_pick 里给的 id' },
          name: { type: 'string', description: '店名片段（可选）' },
          fresh: { type: 'boolean', description: 'true = 打开店铺页重新读' },
        },
        additionalProperties: false,
      },
      async ({ storeId = '', name = '', fresh = false } = {}) => {
        try {
          const result = await jd.menu({ storeId, name, fresh })
          const shop = result.shop
          const lines = []
          lines.push(`【${shop.name}】${shop.distance || ''}${shop.eta ? ` · ${shop.eta}` : ''}${shop.minPrice ? ` · 起送 ¥${shop.minPrice}` : ''}`)
          for (const dish of (shop.dishes || []).slice(0, 40)) {
            lines.push(`- ${dish.name}${dish.price ? ` ¥${dish.price}` : ''}`)
          }
          if (result.note) lines.push('', result.note)
          lines.push('', `链接：${shop.url}`, `id：${shop.id}`)
          return { text: lines.join('\n'), shop }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'jd: menu',
  )

  register(
    tool(
      'jd_order',
      [
        '京东外卖点餐：在用户自己的 Edge 里把一份餐点到「提交订单」页，然后停下等用户自己付款。',
        '',
        'action:"start"（默认）：打开这家店 → 找到 dish 这道菜 → 点「去抢购」→ 选份数 → 点「确定」→ 落到结算页，并把地址/金额读回来。',
        'action:"read"：只读当前结算页（地址、送达时间、商品、商品金额、运费、优惠券、合计），什么都不点。',
        'action:"view"：看购物车底栏。',
        'action:"checkout"：打开结算页（老路子，走购物车）。',
        '',
        '**边界（写死的）**：「立即支付 / 提交订单 / 付款」这些按钮插件一律拒绝点击，只能用户自己点。',
        '干完把结果讲清楚：点到了什么、结算页上的地址对不对、合计多少，然后提醒用户「你自己确认后点立即支付」。',
      ].join('\n'),
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'read', 'view', 'checkout'], description: '默认 start' },
          storeId: { type: 'string', description: 'jd_pick 给的 id' },
          name: { type: 'string', description: '店名片段（可选）' },
          dish: { type: 'string', description: '要点的菜名（如「香辣大鸡排+单根烤肠」）' },
          dishes: { type: 'array', items: { type: 'string' }, description: '多道菜（currently 只点第一道，其余留作扩展）' },
          portion: { type: 'number', description: '份数，默认 1' },
          active: { type: 'boolean', description: 'true = 把标签页切到前台（默认 true）' },
        },
        additionalProperties: false,
      },
      async ({ action = 'start', storeId = '', name = '', dish = '', dishes = [], portion = 1, active = true } = {}) => {
        try {
          if (action === 'read') {
            const order = await jd.readOrder()
            return { text: renderCheckout('当前结算页', order), order }
          }

          if (action === 'view') {
            const cart = await jd.cart()
            const lines = ['当前京东购物车：']
            for (const bar of cart?.bars || []) lines.push(`- ${bar.text}`)
            if (cart?.badge?.length) lines.push(`件数标记：${cart.badge.join(' / ')}`)
            if (!cart?.bars?.length) lines.push('（底栏没读到东西，可能购物车是空的）')
            return { text: lines.join('\n'), cart }
          }

          if (action === 'checkout') {
            const result = await jd.checkout({ storeId, name, active })
            const lines = [
              `【${result.shop.name}】已尝试去结算${result.clicked?.ok ? '' : `（没点着：${result.clicked?.reason || '没找到「去结算」'}）`}`,
              '现在停在结算页前面。',
              '',
              '**接下来你自己来**：确认地址、餐具、优惠没问题后，自己点「提交订单」并付款——我不会替你点这两步。',
            ]
            if (result.text) lines.push('', `页面现在是这样：${result.text.slice(0, 240)}`)
            return { text: lines.join('\n'), ...result }
          }

          const result = await jd.start({ storeId, name, dish, dishes, portion, active })
          const lines = [`【${result.shop.name}】`, '我做了什么：']
          for (const step of result.steps) lines.push(`- ${step}`)
          lines.push('', renderCheckout(result.onCheckout ? '结算页' : '当前页面', result.order))
          lines.push('')
          lines.push(result.note)
          return { text: lines.join('\n'), ...result }
        } catch (error) {
          return fail(clip(error?.message || error, 300))
        }
      },
    ),
    'jd: order',
  )

  register(
    tool(
      'jd_status',
      '看京东这条链路通不通：扩展连没连上、当前缓存了几家店、缓存多久了。报错时先调它。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const status = jd.status()
        const lines = [
          `扩展连接：${status.connected ? '已连上' : '没连上（Edge 里「DSH 点餐桥」要启用）'}`,
          `桥端口：${status.bridge?.port || '?'}｜最近轮询：${status.bridge?.lastPollAt || '还没'}`,
          `缓存店家：${status.cachedShops} 家${status.cachedAt ? `｜${new Date(status.cachedAt).toLocaleString('zh-CN')}` : ''}${status.stale ? '（已过期，下次会重读）' : ''}`,
        ]
        return { text: lines.join('\n'), status }
      },
    ),
    'jd: status',
  )
}

function renderTaste(taste) {
  const lines = []
  lines.push(`- 爱吃：${taste.likes.length ? taste.likes.join('、') : '（还没记）'}`)
  lines.push(`- 不吃：${taste.dislikes.length ? taste.dislikes.join('、') : '（还没记）'}`)
  lines.push(`- 辣度：${['不吃辣', '微微辣', '正常辣', '无辣不欢'][taste.spicy] ?? taste.spicy}`)
  lines.push(`- 人均预算：${taste.budget ? `¥${taste.budget}` : '（没设）'}`)
  lines.push(`- 控卡：${taste.health ? '是' : '否'}`)
  if (taste.note) lines.push(`- 备注：${taste.note}`)
  return lines.join('\n')
}

/** 把解析出来的结算页信息渲染成人话 */
function renderCheckout(title, order = {}) {
  const money = (value) => (value === null || value === undefined ? '—' : `¥${value}`)
  const lines = [`${title}：`]
  if (order.shop) lines.push(`- 店铺：${order.shop}`)
  if (order.address) lines.push(`- 送到：${order.address}${order.receiver ? ` · ${order.receiver}` : ''}`)
  if (order.eta) lines.push(`- 时间：${order.eta}`)
  if (order.itemsText) lines.push(`- 商品：${order.itemsText.replace(/\s+/g, ' ')}`)
  lines.push(`- 商品金额 ${money(order.goods)} · 运费 ${money(order.freight)} · 优惠 ${order.coupon ? `-¥${order.coupon}` : '—'}`)
  lines.push(`- **合计 ${money(order.total)}**`)
  lines.push(order.payButton ? '- 页面上有「立即支付」——**这一步留给你自己点**' : '- 页面上还没出现「立即支付」（可能没到起送价）')
  return lines.join('\n')
}
