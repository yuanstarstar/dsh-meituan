import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './lib/store.js'
import { Meituan } from './lib/meituan.js'
import { Bridge } from './lib/bridge.js'
import { Jd } from './lib/jd.js'
import { createHttpHandler } from './lib/http.js'
import { registerTools } from './lib/tools.js'

export const inject = ['tools', 'webServer']

const ROOT = path.dirname(fileURLToPath(import.meta.url))

export function apply(ctx) {
  const logger = ctx.logger
  const store = new Store(ROOT)
  const meituan = new Meituan({ store, logger, root: ROOT })

  // 「真浏览器 + 扩展」这条线：DSH 这边起个小桥，扩展在用户自己的 Edge 里长轮询取命令
  const bridge = new Bridge({ store, logger })
  const jd = new Jd({ store, bridge, logger })

  registerTools(ctx, { store, meituan, jd })

  const http = createHttpHandler({ store, meituan, jd, logger })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: http.path, handler: http.handler }), 'meituan: http')

  ctx.effect(() => {
    bridge.start().catch((error) => logger.warn(`点餐桥没起来：${error?.message || error}`))
    return () => {
      bridge.stop().catch(() => {})
    }
  }, 'meituan: bridge')

  ctx.effect(() => () => meituan.stop(), 'meituan: dispose')
  logger.info(
    '外卖已加载：jd_pick / jd_menu / jd_status（京东，走扩展）、meituan_pick / meituan_shops / meituan_menu / meituan_cart / meituan_order / meituan_login / meituan_taste（美团）',
  )
}
