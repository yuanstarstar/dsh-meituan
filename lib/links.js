// 美团 App 的深链：点开直接落到「这家店的这道菜」，一格就能加车。
//
// 为什么需要它：实测（probe-cart-persist / probe-cart-network / probe-cart-endpoints）
// 美团外卖网页端点「+」只发一个 calculateprice（算价）请求，购物车数据存在浏览器
// localStorage 的 cached_cart_data 里——换个浏览器资料就没了，App 那边也看不到。
// 也就是说网页端没有「写进 App 购物车」的能力，所以只能把人送到 App 的那道菜上。
export function appDeepLink(poiId, spuId = 0) {
  const id = String(poiId || '').trim()
  if (!id) return ''
  const parts = ['restaurant_id=-100', `poi_id_str=${encodeURIComponent(id)}`]
  if (Number(spuId) > 0) parts.push(`spu_id=${Number(spuId)}`)
  return `meituanwaimai://waimai.meituan.com/menu?${parts.join('&')}`
}

export function webMenuLink(poiId, spuId = 0) {
  const id = String(poiId || '').trim()
  if (!id) return ''
  const dish = Number(spuId) > 0 ? `&dishId=${Number(spuId)}` : ''
  return `https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=${encodeURIComponent(id)}${dish}`
}
