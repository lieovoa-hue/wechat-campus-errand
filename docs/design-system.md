# 校园跑腿小程序 · 设计系统 v6（iOS / Apple HIG 风格）

> 本文件是全站 UI 的唯一依据。改视觉先改这里，再改 `miniprogram/app.wxss` 里的设计令牌，
> 页面里不允许再写裸色值。文件名：`docs/design-system.md`。
>
> **v6 相对 v5 的变更摘要**
> 1. 主色从 iOS systemBlue `#007aff` 换成**信任蓝 `#2b5ce6`**：白底文字 5.5:1、蓝底白字 5.5:1，
>    **文字与按钮双向都过 WCAG AA**；v5 里「蓝色文字必须用 `#0062cc`」这条约束随之取消。
> 2. 新增**辅助色暖橙 `#ee6c2d`**（金额文字档 `#c2410c`）：只用于「金额 / 紧迫 / 权益」三类信息，
>    与主色形成冷暖分工，避免「满屏都是蓝」的廉价感。
> 3. 语义色不再是 iOS 原色，改成**一套自洽的三档色板**：文字档按 AA 校准
>    （绿 `#0a7a54` / 橙 `#b45309` / 红 `#c81e1e`），填充档只做装饰，淡底只做徽标背景。
> 4. 中性色改为**冷灰阶**：底 `#f5f7fa` → 分隔 `#e6eaf2`（实体冷灰，不再是半透明黑）→
>    描边 `#d5dbe6` → 文字 `#0f172a / #475569 / #6b7688 / #9aa5b4`。
> 5. 圆角与字号**收紧成两套固定阶梯**：圆角 8 / 16 / 28 / 32 / pill，
>    字号 22 / 24 / 28 / 30 / 34 / 44 / 52（rpx）。页面里原本散落的
>    18、20、22、26、29、32、38、40、48、56rpx 这次已全部归位到令牌。
> 6. 阴影换成带蓝调的中性投影（`rgba(15,23,42,…)`），新增 `--scrim` 遮罩令牌；
>    动效曲线与时长沿用 v5（按压 120ms / 状态 220ms / 弹窗 320ms，禁用 `ease-in`）。
> 7. tabBar 图标配色随主色调整，改配色后必须重跑 `python tools\make_tab_icons.py`。

---

## 一、设计原则

服务对象是**在校学生**，使用场景是「课间两分钟掏出手机」：边走边看、单手操作、随时被打断。
本设计只坚持三条：

1. **一眼看清** — 每张卡片把「送到哪 / 多少钱 / 还剩多久」放在最显眼位置，其余信息下沉到详情页。
2. **一次点对** — 一个页面只有一颗高饱和主按钮；危险操作统一红色，绝不和主操作抢注意力。
3. **不打扰** — 动效只用于「进场 / 按压 / 状态变化」三类，时长 120~400ms，
   按压反馈在 pointer-down 即刻发生（`:active`），不做无意义装饰。

---

## 二、颜色令牌（`miniprogram/app.wxss` 的 `page` 上定义）

### 主色 · 信任蓝（全站唯一强调色）

| 令牌 | 值 | 对比度 | 用途 |
|---|---|---|---|
| `--brand` | `#2b5ce6` | 白底 5.5:1 / 蓝底白字 5.5:1 | 主填充色：主按钮、选中态、悬浮按钮 |
| `--brand-deep` | `#2b5ce6` | 5.5:1 | **浅底上的蓝色文字与图标**（与主色同值，语义更明确） |
| `--brand-ink` | `#1e49c4` | 7.5:1 | 按压态 / 需要更深对比的深色填充 |
| `--brand-light` | `#5b84f0` | 3.5:1 | 浅色端，**仅装饰**，不承载文字 |
| `--brand-soft` | `#eef3ff` | — | 极浅品牌底（图标底、选中行、空态底图） |
| `--brand-line` | `#dce6ff` | — | 品牌色描边、聚焦环 |
| `--brand-on` | `#ffffff` | 5.5:1 | 品牌色之上的文字色 |

> v6 的关键改进：`#2b5ce6` 让**文字与按钮双向都过 AA**（v5 的 `#007aff` 作文字只有 3.0:1，
> 必须另拆一个 `#0062cc` 才能用）。现在 `--brand` 与 `--brand-deep` 同值，
> 「蓝底白字」和「白底蓝字」都达标，页面里不用再纠结该取哪一个。

### 辅助色 · 暖橙（金额 / 紧迫 / 权益）

| 令牌 | 值 | 对比度（白底） | 用途 |
|---|---|---|---|
| `--accent` / `--accent-fill` | `#ee6c2d` | 3.1:1 | 纯装饰色块、模板图标底、权益角标 |
| `--accent-deep` | `#c2410c` | 5.2:1 | **金额文字**（服务费、酬金、账单） |
| `--accent-soft` / `--money-soft` | `#fff1e7` | — | 金额 / 权益的淡底 |
| `--money` | `#c2410c` | 5.2:1 | 兼容别名，等同 `--accent-deep` |

> 暖橙是**第二个强调色，但只准用于「钱」和「权益」**。除此之外全站仍然只有一种强调色。
> 曾经出现过的 `.fee-amount` 用红色 `#c81e1e` 表示金额，已修正为 `--money`。

### 系统色兼容别名（组件内可能引用，勿删）

| 令牌 | 值 | 令牌 | 值 |
|---|---|---|---|
| `--ios-blue` | `#2b5ce6` | `--ios-pink` | `#d6336c` |
| `--ios-green` | `#0e9f6e` | `--ios-purple` | `#7048e8` |
| `--ios-orange` | `#d97706` | `--ios-teal` | `#0c8599` |
| `--ios-red` | `#e02424` | `--ios-indigo` | `#4263eb` |
| `--ios-yellow` | `#e8a100` | | |

### 冷灰阶（旧 iOS 灰阶的替代，全部换成冷调）

`--gray #6b7688` · `--gray-2 #9aa5b4` · `--gray-3 #c3cbd8` ·
`--gray-4 #d5dbe6` · `--gray-5 #e6eaf2` · `--gray-6 #f1f4f9`

> 这 6 个名字只为兼容旧组件保留，新代码请直接使用 `--text-*` / `--surface-*` / `--line*`。

### 语义色

| 语义 | 文字档（AA 校准） | 填充档（仅装饰） | 淡底 | 用途 |
|---|---|---|---|---|
| 成功 | `--success #0a7a54`（5.4:1） | `--success-fill #0e9f6e` | `--success-soft #e8f7f1` | 已完成、已认证、收入 |
| 警告 | `--warn #b45309`（5.0:1） | `--warn-fill #d97706` | `--warn-soft #fef3e2` | 进行中、待审核、服务费提醒 |
| 危险 | `--danger #c81e1e`（5.7:1） | `--danger-fill #e02424` | `--danger-soft #feecec` | 超时、撤销、封禁、注销 |

> 三档用法的硬规则：**文字与图标用「文字档」，纯装饰色块用「填充档」，徽标背景用「淡底」**，
> 三者不可互换。填充档在白底上只有 3.2~4.7:1，拿它承载 22~28rpx 的文字属于不合格。

### 文字层级（对齐 iOS label / secondaryLabel）

| 令牌 | 值 | 对比度（白底） | 用途 |
|---|---|---|---|
| `--text-1` | `#0f172a` | 18.1:1 | 主文字、标题、金额 |
| `--text-2` | `#475569` | 7.5:1 | 次级文字、表单标签 |
| `--text-3` | `#6b7688` | 4.5:1 | 辅助说明、字段名（正好卡在正文 AA 下限） |
| `--text-4` | `#9aa5b4` | 2.5:1 | **仅**占位符与装饰图形，禁止承载正文 |
| `--text-on-dark` | `#ffffff` | — | 深色底 / 品牌色底之上的文字 |

`--bg #f5f7fa`（页面底色，冷灰）、`--bg-grad`（与 `--bg` 同色的占位渐变，
已挂在全局 `page` 上，页面**不要**再写 `background-image` 覆盖它）、
`--surface #ffffff`（卡片）、`--surface-2 #f1f4f9`（卡内嵌块 / 输入框底）、
`--surface-3 #e6eaf2`（灰标签底 / 分段控件轨道）、
`--line #e6eaf2`（分隔线）、`--line-strong #d5dbe6`（输入框描边）。

> 分隔线不再用半透明黑：改用**实体冷灰** `#e6eaf2`。半透明黑在深色截图里会发灰发脏，
> 实体色在真机和高分屏上都更干净。

---

## 三、间距：4rpx 网格

`--sp-1: 4` `--sp-2: 8` `--sp-3: 12` `--sp-4: 16` `--sp-5: 20` `--sp-6: 24` `--sp-8: 32` `--sp-10: 40` `--sp-12: 48`（单位 rpx）

- 页面左右统一 `--page-pad: 32rpx`。
- 卡片内边距 `--sp-8 32rpx`；卡片之间 `--sp-6 24rpx`；卡内元素之间 `--sp-2 ~ --sp-4`。
- 徽标 / 标签的内边距统一 `2rpx 12rpx`（与 `app.wxss` 的 `.tag` 一致）。
- 任何间距都不要写 13、17、22、26 这类不在 4rpx 网格里的值（徽标内的 1~2rpx 视觉微调除外）。

---

## 四、字号阶梯（1pt = 2rpx，对齐 iOS 字体大小）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--fs-cap` | 22rpx（11pt） | 标签、角标、极小提示 |
| `--fs-sm` | 24rpx（12pt） | 辅助说明、字段值 |
| `--fs-body` | 28rpx（14pt） | 正文默认（`page` 基准） |
| `--fs-md` | 28rpx（14pt） | 表单输入、信息行 |
| `--fs-lg` | 30rpx（15pt） | 卡片标题 |
| `--fs-title` | 34rpx（17pt） | 区块标题、主按钮文字 |
| `--fs-h1` | 44rpx（22pt） | 关键数字、Large Title |
| `--fs-display` | 52rpx（26pt） | 账号 ID 等唯一焦点 |

> 阶梯只有这 8 档（`--fs-body` 与 `--fs-md` 同值，保留两个名字是为了语义清晰）。
> 页面里**不再写 `font-size: 26rpx` 这类裸值**，一律引用令牌。
> 金额的层级规则：**卡片里用 `--fs-title`，详情页里用 `--fs-h1`**，全站仅此两档。

正文行高 1.5；金额与倒计时使用 `font-variant-numeric: tabular-nums`（等宽数字），
避免数字变化时排版抖动。

**字距（tracking）随字号变化**：大标题（≥ `--fs-h1`）用负字距 `letter-spacing: -1rpx`，
正文接近 0。字体使用系统字体栈
（`-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei'`），
不引入第三方字体。

---

## 五、圆角 / 阴影 / 动效

- 圆角（iOS 连续圆角观感）：`--radius-s 8` `--radius-m 16` `--radius-l 28` `--radius-xl 32`
  `--radius-pill 999`（rpx）。**卡片 28 / 按钮·输入框 16 / 标签 8 / 胶囊用 pill**；
  嵌套时内层圆角 = 外层圆角 − 内边距（如分段控件：轨道 `--radius-m`，滑块 `calc(var(--radius-m) - 4rpx)`）。
- 阴影四级（都是**带蓝调的中性投影**，不再是纯黑）：`--shadow-card`（静置卡片，
  `0 2rpx 8rpx rgba(15,23,42,.05)`）→ `--shadow-raise`（浮起元素，
  `0 6rpx 20rpx rgba(15,23,42,.08)`）→ `--shadow-brand`（品牌色按钮投影，
  `0 8rpx 20rpx rgba(43,92,230,.22)`）→ `--shadow-modal`（弹窗，
  `0 24rpx 64rpx rgba(15,23,42,.22)`）。
  层次优先靠留白与「白卡 / 灰底」两种材质，阴影只做点缀。
- 遮罩：`--scrim rgba(15,23,42,.6)`（弹窗 / 上传中）、`--scrim-soft rgba(15,23,42,.4)`（图片查看器）。
- 动效时长（Apple 推荐）：`--dur-fast 120ms`（按压，pointer-down 即触发）·
  `--dur-base 220ms`（淡入 / 状态切换）· `--dur-slow 320ms`（卡片进场 / 弹窗）·
  `--dur-long 400ms`（较大位移、展开收起）。**UI 动画一律 < 300ms 感知阈值内收尾**。
- 缓动（自定义曲线，**不要用内置 `ease` / `ease-in`**）：
  `--ease-out cubic-bezier(0.23,1,0.32,1)`（进入 / 退出：起步快、收尾稳）·
  `--ease-in-out cubic-bezier(0.77,0,0.175,1)`（屏内移动）·
  `--ease-drawer cubic-bezier(0.32,0.72,0,1)`（抽屉 / 底部弹层，iOS 手感）·
  `--ease-spring cubic-bezier(0.22,1.2,0.36,1)`（仅弹出类动效的轻微回弹，默认 UI 动效**不用**回弹）。
- **只动 `transform` 与 `opacity`**，不动 `width/height/top/left`，避免重排与布局抖动。
- 进入与退出**走同一条路径**（从哪进就从哪出），`transform-origin` 锚定触发源。
- 系统开启「减弱动态效果」时，第 16 节的 `prefers-reduced-motion` 规则会把动画压到近 0 并只播一帧。

---

## 六、组件规范

### 按钮
### 按钮
- `.btn` 高 `--touch 88rpx`（≈44pt），圆角 `--radius-m 16rpx`，字号 `--fs-lg 30rpx`；
  全站唯一主按钮 `.btn-primary` 用**纯色 `--brand`**（iOS 按钮是纯色块，不用渐变），
  禁用态 `opacity: 0.36`。
- `.btn-sm` 高 72rpx，用于卡片底部并排的次要操作，行间距 ≥ `--sp-4`。
- `.btn-plain`（蓝底浅色，次要）· `.btn-danger`（红底浅色，危险）· `.btn-disabled`（灰，不可点）·
  `.btn-text`（纯文字，用于「查看全部」这类弱操作）。
- **宽度只有三种规则**：全宽 `.btn-block`、半宽并排 `.btn-row > .btn`（`flex: 1 1 0`）、
  行内小按钮 `.btn-sm`。不允许出现「半宽孤儿按钮」——同一行的按钮必须等宽平分。
- 按下反馈统一 `transform: scale(0.97)` + `opacity` 微降，**绝不改变尺寸**。

### 标签 `.tag`（徽标：**同色系淡底 + 深色字，不加描边**）
- 背景只包裹文字：`flex: none` + `width: fit-content` + `white-space: nowrap`；
  内边距统一 `2rpx 12rpx`，圆角 `--radius-s 8rpx`（**不是胶囊**——胶囊只留给「按钮」和「筛选 chip」）。
  （在 flex 行里若不给前两个属性，背景框会被撑大——历史上踩过这个坑。）
- 变体：`.tag-success`（`--success-soft` 底 / `--success` 字）已认证 ·
  `.tag-warn`（`--warn-soft` / `--warn`）进行中、待审核 ·
  `.tag-danger`（`--danger-soft` / `--danger`）超时、驳回 ·
  `.tag-gray`（`--surface-3` / `--text-3`）中性 ·
  `.tag-admin`（`--danger-soft` / `--danger` 红底红字，管理员**不显示**「已认证」标签）。
- 徽标一律「淡底 + 深色字」，**禁止**用纯色填充（纯色填充是按钮的语义）。

### 表单
- `.form-item` 高 ≥100rpx，`.form-item-area` 用于多行文本；最后一项去掉底部分隔线。
- 标签宽 180rpx（`--form-label`），右侧输入无边框，靠 iOS separator 分隔线分隔。
- 错误提示必须紧贴字段下方（`.form-tip` / `.auth-tip-danger`），不要只堆在页面顶部。

### 分段控件（iOS Segmented Control）
- 灰轨道 `--surface-3` + 白色滑块 + `--radius-m` + 极淡投影，用于分类切换
  （如 `auditApply` 的头像 / 昵称切换）。

### 弹窗
- `.mask`（`--scrim rgba(15,23,42,.6)`；图片查看器与上传中遮罩用更浅的
  `--scrim-soft rgba(15,23,42,.4)`）+ `.modal`（宽 620rpx，`--radius-xl`，`--shadow-modal`，
  `ds-pop-in` 进场 0.26s）。
- 底部 `.modal-foot` 两个等宽按钮；不可点用 `.modal-btn-disabled`（灰）而不是隐藏。

### 空态与加载
- `.empty` 自带柔和圆形底图（`::before`，尺寸 144rpx，`--brand-soft → --surface-2` 的淡渐变、无描边），
  避免大片空白让人以为页面坏了。
- 首屏加载用骨架屏 `.skeleton`（`index` 页已用），底色 `--surface-3 #e6eaf2` / `--surface-2 #f1f4f9`，
  加载 >300ms 必须有反馈。
- 首屏加载用骨架屏 `.skeleton`（`index` 页已用），加载 >300ms 必须有反馈。

---

## 七、图标（重要）

**禁止用 emoji 当图标**（不同机型字形/大小/颜色不一致，且无法跟随主题色）。
统一用 `app.wxss` 第 6 节的 CSS 绘制图标，颜色继承 `currentColor`：

| 类名 | 图形 | 用途 |
|---|---|---|
| `.ico-search` | 放大镜 | 查看详情、搜索 |
| `.ico-ban` | 禁止符 | 处罚、封禁 |
| `.ico-trash` | 垃圾桶 | 删除订单 |
| `.ico-lock` | 锁 | 重置密码、密保 |
| `.ico-edit` | 铅笔 | 编辑订单、修改资料 |
| `.ico-minus` | 圆减号 | 注销账号 |
| `.ico-info` | 圆形感叹号 | 提示说明 |
| `.ico-eye` / `.ico-eye-off` | 眼睛 / 划掉的眼睛 | 显示、隐藏密码（热区 72x72rpx） |
| `.ico-close` | 叉号 | 清空输入框、删除已上传图片 |
| `.ico-plus` | 加号 | 上传照片、悬浮发布按钮 |
| `.ico-clock` | 时钟 | 限时、倒计时 |
| `.ico-box` | 纸箱 | 「取快递」快捷模板 |
| `.ico-bowl` | 饭碗 | 「食堂带饭」快捷模板 |
| `.ico-doc` | 文稿 | 「打印资料」快捷模板 |
| `.ico-bag` | 购物袋 | 「超市代买」快捷模板 |

用法：`<view class="ico ico-search"></view>`，颜色由父级 `color` 决定。

> `.ico` 本体是 32x32rpx 的盒子，内部图形用归一化的 `::before` / `::after` 定位。
> 需要放大时用 `transform: scale(n)`（不改变布局占位），**不要**直接改 `width/height`，否则图形会错位。

---

## 八、布局与无障碍

- 触摸目标 ≥ 88rpx（≈44pt）；紧凑行内按钮 72rpx 且行间距 ≥16rpx。
- 正文/背景对比度 ≥4.5:1；大号文字（≥34rpx 粗体）≥3:1。上表 token 均已校准。
- 有「安全区」需求的页面底部必须放 `<view class="safe-bottom"></view>`。
- 底部固定元素（悬浮按钮）下方内容要预留安全内边距（`fixed-element-offset`）。
- 不靠颜色单独表意：未读消息用「红点 + 位置」双重编码，状态用「色条 + 文字标签」双重编码。
- hover 效果必须用 `@media (hover: hover) and (pointer: fine)` 门控，避免触屏「悬停卡住」；
  全局已设 `-webkit-tap-highlight-color: transparent` 与 `touch-action: manipulation`。
- 系统开启「减弱动态效果」时走第 16 节降级：交叉淡入替代位移 / 弹性。

---

## 九、页面清单与设计意图

| 页面 | 设计意图 |
|---|---|
| `login` | 白底 + **iOS Large Title**（大黑字 + 负字距），无彩色渐变；单输入框双方式登录；主操作一颗全宽纯色蓝胶囊；底部「还没账号？去注册 / 忘记密码」收成小字 |
| `register` / `forgot` | 与 `login` 同一套 `styles/auth.wxss`，保持进入 / 退出一致的观感；注册页含协议勾选 |
| `index` 任务大厅 | Large Title「任务大厅」独占一行 → 下方独立搜索行（iOS 灰填充搜索框 `rgba(118,118,128,.12)` + 圆角 20rpx + 右侧蓝色「取消」文字，聚焦时出现）→ 排序胶囊（纯色蓝选中）+ 酬金筛选卡；任务卡片流；右下纯色蓝悬浮「+ 发布任务」 |
| `taskDetail` | 送达地址作标题 → 酬金/限时/倒计时关键数字条（`--surface-2` 灰底） → 明细 → 相关人员 mini 卡片 → 图片 → 操作；限时任务在雇主 / 接单者两侧都显示实时倒计时 |
| `myPublish` / `myTake` | 状态标签分段 + 状态分组标题；卡片底部并排次要操作；`myTake` 有未完成任务时 tabBar 显示数字角标 |
| `profile` | 无渐变分区；账号 ID 用 `--brand-deep` 深蓝实底卡片承载（白字 5.8:1）并支持一键复制；入口按「账号安全 / 我的记录 / 管理」分组 |
| `publishTask` | 快捷模板做成 2 列网格卡片（iOS 系统色图标底 + 名称 + 预置酬金/限时摘要，「取快递」右上角红色免费次数角标）；输入框统一浅灰填充、无描边；酬金与限时并排一行；服务费卡金额放大并配暖色淡底 |
| `message` / `messageDetail` | 消息中心用紧凑行（左侧未读竖条 + 右上角未读小圆点 + 类型标签），顶部放「全部已读 / 清除未读」条；点击行进入详情页，详情页进入即标记已读 |
| `bill` | 纯记账展示，顶部收支合计三列分隔，**无任何提现入口** |
| `admin` | 等宽三列操作格（图标 + 文字）；搜索、封禁、用户、订单四个 Tab；表格类列表用 iOS 分组行（白卡内分隔线内缩） |
| `campusCert` | 上传规则用红色警示块显眼标注，示例图带描边 |
| `devices` / `securitySetup` | 与登录态同一套视觉，列表行右对齐箭头 `--text-4` |

---

## 十、iOS 设计语言落地要点（HIG 依据）

1. **单一强调色**：全站只有 `--brand` 一种强调色。第二强调色会立刻稀释层级，
   需要区分时用「灰阶 + 字号 + 字重」，不要引入新色相。
2. **层次靠材质而非描边**：iOS 靠「白卡浮在灰底上」表达层级。
   卡片默认无描边，需要区分时优先用 `--surface-2` 灰底或 iOS separator。
3. **分组内分隔线内缩**：列表行之间的分隔线左侧内缩到与文字对齐（`inset`），
   不要画通栏横线；滚动边缘用渐隐遮罩而不是 1px 硬分割线。
4. **默认 UI 动效无过冲**：Apple 默认 spring 为 `damping 1.0 / response 0.3~0.4`（无过冲）。
   本项目的 `--ease-spring` 只准用在弹出类动效，页面切换与列表进场一律用
   `--ease-out` / `--ease-in-out`。
5. **按压反馈立刻可见**：`transform: scale(0.97)` 在 pointer-down 帧就要生效
   （时长取 `--dur-fast` 甚至 0），松手回弹可用 `--ease-out`。
6. **材质叠加规则**：浅色半透明**不可**叠在浅色半透明之上；
   需要模糊时用 `backdrop-filter: blur() saturate()` + `border-top: 1px solid rgba(255,255,255,.4)`。
   小程序端 WebView 对 `backdrop-filter` 支持不一，本项目一律用**不透明色**替代，避免观感劣化。
7. **无障碍**：`prefers-reduced-motion`、对比度、触摸目标三条为**硬约束**，改动 UI 时必须复核。

---

## 十一、维护约定（改 UI 前必读）

1. 只改 `app.wxss` 的令牌就能全站换色，页面里**不要**写裸 hex。
2. 组件（`taskCard` / `userCard` / `pageFooter`）内用 `var(--token, 兜底值)`，
   变量取不到也不会崩；关键帧需在组件内单独定义一份（组件取不到全局关键帧）。
3. 两个列表页共用 `miniprogram/styles/list.wxss`，三个登录态页面共用 `miniprogram/styles/auth.wxss`，
   改通用样式去这两个文件改，不要复制粘贴到页面里。
4. 改完必须跑 `node backend/scripts/checkMiniProgram.js`（校验 `<text>` 内不能换行、
   标签闭合、花括号平衡等），失败 0 才算过。
5. `miniprogram/app.js` 的全局类名以外，页面里用到的每个 class 都必须在本页 wxss、
   `styles/*.wxss` 或 `app.wxss` 里有定义，避免出现「写了 class 却没样式」的静默失效。
6. 改 tabBar 配色后必须重跑 `python tools\make_tab_icons.py` 重新生成 8 张 PNG，
   否则图标颜色会和 `app.json` 里的 `selectedColor` 不一致。

---

## 十二、深色模式（v6.1 · 方案 A「分层深灰」）

### 1. 三层结构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 令牌层 | `app.wxss` 的 `.theme-light` / `.theme-dark` | 只定义一套 CSS 变量，与 `page` 上的浅色默认值一一对应 |
| 系统层 | `app.json` 的 `darkmode` + `theme.json` | 系统主题变化时，导航栏 / tabBar / 窗口底色交给微信自己切 |
| 真值层 | `utils/theme.js` | 「手动偏好 > 系统 > 浅色」的唯一判断口径 |

页面只做三件事：`data.themeClass: theme.getClass()`、`onShow` 调 `theme.sync(this)`、
`onUnload` 调 `theme.unsync(this)`。颜色一律走变量，页面里不写裸 hex。

### 2. `.theme-root` 是硬约定（发布页踩过坑）

- **页面根节点**：`class="container {{themeClass}} theme-root"`。
  多挂的这个 `.theme-root` 才会吃到 `min-height: 100vh` 铺满整屏，
  避免内容不足一屏时露出 `page` 的浅色底（深色下就是一条白边）。
- **遮罩 / 底部弹层 / 固定底栏**（`.mask` / `.sheet` / `.sheet-mask` / `.pub-foot`）：
  只挂 `{{themeClass}}`（它们不在根节点的子树里，不挂就拿不到深色令牌，会回落成浅色），
  **绝对不能挂 `.theme-root`**：它们本身就是 `position: fixed`，
  吃到 `min-height: 100vh` 会被拉成整屏 —— 发布页固定底栏曾因此变成 887px 高，把整页正文盖住。

`node backend/scripts/checkTheme.js` 会逐页断言这两条（外加 WXML 标签必须闭合、
暗色 tabBar 图标必须存在、`theme.json` 与 `theme.js` 的原生外观表必须一致），改错直接失败。

### 3. 用户怎么用

- 首页品牌行右侧的滑动开关：**点击**在浅色 / 深色之间切换（写入本地缓存 `themeMode`，手动偏好优先）；
- **长按**该开关：恢复「跟随系统」（清除手动偏好；首次点击时会 toast 提示这一点）。

### 4. 已知边界

- `wx.showModal` 等**原生弹窗**跟随的是**系统**深浅色，不跟小程序里的手动开关。
  全项目 25 处（13 个文件）；若要求手动深色下弹窗也变暗，需要换成自绘弹窗组件。
- 后端生成的图形验证码是浅底图片，深色下会显示成一块浅色圆角块（功能正常）。

### 5. 改完必须跑的检查

```
node backend/scripts/checkTheme.js        # 接线 / 令牌 / 暗色图标 / 顶层节点挂类 / 标签闭合
node backend/scripts/checkThemeMode.js    # 跟随系统与手动覆盖的真值表（mock wx，30 条断言）
node backend/scripts/checkMiniProgram.js  # 隐藏字符 / 主题变量解析等通用自检
```
