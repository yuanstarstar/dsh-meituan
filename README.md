# 外卖点餐助手（dsh-meituan）

不知道吃什么的时候，跟 DSH 说一句「帮我点个外卖」，它自己翻附近的店、按你的口味排个序、还能把一份餐**点到结算页**——最后一步付款留给你自己点。

支持两条链路：

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| 京东秒送 / 京东外卖 | ✅ 可用 | 读商家、读菜单、把餐点到「提交订单」页 |
| 美团外卖（h5） | ⚠️ 受限 | 代码都在；但网页端内容接口对登录账号返回 403（见「已知边界」），目前只能匿名看首页列表 |

两种读法：

- **无登录态（默认，推荐）**：挂在你自己 Edge 上的「DSH 点餐桥」扩展在页面里旁听，请求由页面自己发、自己签名；插件只读结果、只做真实点击。不伪造请求、不换 UA、不改坐标。
- **带登录态（旧路径）**：插件自己起一个无头 Edge（CDP），cookie 存在 `data/browser-profile`。美团那条线就是这么跑的。

---

## 装起来

### 1) 装插件本体

```
plugin_manager action:"install_bundle" target:"<这个目录的绝对路径>"
```

装完**重启一次 DSH Desktop**（宿主模块有 ESM 缓存，不重启还是老代码）。

### 2) 装「DSH 点餐桥」扩展（京东那条线必须）

1. Edge 打开 `edge://extensions` → 打开「开发人员模式」
2. 「加载解压缩的扩展」→ 选这个包里的 `extension` 目录
3. 扩展自动连 `http://127.0.0.1:45321`（端口和 token 在 `data/bridge.json`，宿主第一次启动时生成）
4. 改过扩展代码之后，必须回 `edge://extensions` 点一次「刷新」

### 3) 登录

- **京东**：在你自己的 Edge 里打开 <https://hour.jd.com/aggregationChannel/home?channelType=wmSingleChannel&svcType=lbs&busiAppKey=jd_jddj&mtaChannelId=32763>，用手机号登录一次。
  注意：**京东主站登录 ≠ 外卖登录**，外卖频道有自己的登录页（`plogin.m.jd.com?appid=2193`），两边都登一次才行。
  万一弹滑块验证：**你自己拖**，插件不会替你过验证。
- **美团**：设置页里填手机号 → 发验证码 → 填码。不过如上表，登录态目前被 403 挡着。

配送地址以**平台账号里保存的地址**为准：插件改不了（也没去改），想换送餐地点就在 App/网页里改，改完插件读到的就是新的。

---

## 工具

| 工具 | 干什么 |
| --- | --- |
| `jd_pick` | **主力**。读附近商家，按口味打分，返回候选 + 理由 + 链接（可出二维码） |
| `jd_menu` | 读某家店的菜和价 |
| `jd_order` | 把餐点到结算页：`start`（默认）/ `read` / `view` / `checkout` |
| `jd_status` | 扩展连没连上、缓存了几家店、缓存多久了 |
| `meituan_pick` | 美团：附近或按关键词捞店、按口味排序 |
| `meituan_shops` | 美团：商家列表原样输出 |
| `meituan_menu` | 美团：进店读菜单 |
| `meituan_cart` | 美团：点菜方案（App 深链 + 二维码 + 网页菜单链接） |
| `meituan_order` | 美团：电脑上下单（加菜 → 结算页 → 选地址 → 餐具） |
| `meituan_login` | 美团：手机号 + 验证码登录 / 查状态 / 退出 |
| `meituan_taste` | 口味档案：读 / 改 |

**写死的边界**：`立即支付 / 提交订单 / 付款 / 支付 / 确认支付` 这些按钮，代码层面直接拒绝点击（`lib/jd.js` 的 `UNSAFE` 常量）。付款只能你自己来。

---

## 京东点餐怎么走（已跑通的那条路）

```
jd_order{ action:"start", storeId:"1018366591", dish:"香辣大鸡排+单根烤肠" }
```

它做的事：

1. 在你 Edge 里打开店铺页（切到前台）
2. 找到这道菜，必要时先滚动进视口
3. 点「去抢购」→ 弹层里选份数 → 点「确定」
4. 落到 `hour.jd.com/mscenter/mspay/`（标题「提交订单」）
5. 把地址、送达时间、商品、商品金额、运费、优惠券、**合计**读回来给你看

然后停。`jd_order{ action:"read" }` 可以随时再读一遍结算页（什么都不点）。

### 为什么必须「真鼠标」

京东外卖页是 Taro（React Native Web）渲染的，`element.click()` 和合成的 pointer 序列它**完全不认**——试过四种点法，页面一动不动。能点动的只有扩展里的 `realClick`（`chrome.debugger` 发真实输入事件），而且坐标要跟着滚动重算，所以是「先滚进视口 → 取 `rect` → 点中心」。

---

## 美团那条线（代码在，链路受限）

- `meituan_pick` / `meituan_menu` / `meituan_cart` / `meituan_order` 都是完整的：商家列表接口 → 商家对象 → 菜单 → 点菜方案（App 深链 + 二维码）→ 加菜 → 结算页 → 选地址 → 餐具。
- 网页购物车在**浏览器 localStorage**（`cached_cart_data`），不是服务端 → 加了也进不了 App 的购物车。所以点菜方案给的是**深链 + 二维码**：手机点开直接落到那道菜，点一下加车。
- 地址选择、餐具、提交按钮的 DOM 都摸清了，`submit` 需要 `confirm: true` 才会点。

---

## 数据放在哪

全在插件自己的目录里（本地链接安装 → 就是本仓库目录）：

```
data/
  config.json        设置（headless / 预算 / 送餐地点 / 验证等待秒数）
  taste.json         口味档案
  session.json       美团登录态摘要（不含 cookie 本体）
  bridge.json        扩展桥的端口与 token（宿主自动生成）
  jd-cache.json      京东商家缓存（5 分钟有效）
  browser-profile/   无头 Edge 的 profile（美团那条线用）
  qr/                生成的二维码 PNG
```

**这个仓库不含 `data/`**：没有 cookie、没有登录态、没有个人地址和手机号。第一次启动会自己建。

---

## 已知边界

1. **京东扩展必须开着**。扩展没运行 → `jd_status` 显示未连接，`jd_*` 工具会报「京东扩展没连上」。
2. **改扩展要刷新**。`edge://extensions` 点一次「刷新」，否则跑的是旧代码（版本见 `extension/manifest.json`）。
3. **美团网页端 403**。登录账号访问 `openh5/home/shopList`、`search/globalpage`、`openapi/v1/poi/food` 一律 403（响应头 `X-Forbid-Code`），匿名反而正常；同一个账号在 App 里正常。已排除网络/代理/UA/自动化/CDP/定位/脏 cookie/重登，判定为账号级限制。缓过来之前美团只能当「深链 + 二维码」用。
4. **风控一律人工**。滑块、短信验证码都由你自己过；插件最多把窗口弹出来等你。
5. **只到结算页**。付款、提交订单永远是人点。

---

## License

MIT。
