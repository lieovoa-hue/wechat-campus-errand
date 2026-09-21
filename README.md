# 校园跑腿微信小程序（完整可运行项目）

> 技术栈：原生微信小程序（WXML/WXSS/JS/JSON） + Node.js Express + MySQL 8.0（mysql2/promise，全 async/await）
> 目录：`backend/`（后端服务）、`miniprogram/`（小程序前端）

---

## 一、项目总览

### 1.1 功能范围

| 模块 | 能力 |
| --- | --- |
| 账号体系 | 手机号 / 账号ID 双方式登录、注册、双令牌刷新、忘记密码（手机号+验证码） |
| 安全 | bcrypt 加密、JWT 双令牌、单设备登录、接口限流、防暴力破解锁定、XSS 转义、SQL 参数化、越权校验 |
| 校园认证 | 4 项资料提交、7 天 3 次限制、真实学号全局唯一、未认证只能浏览 |
| 任务 | 发布/支付上架、接单（乐观锁）、10 分钟取消、限时超时自动扣 5% 酬金（任务不取消、可继续送达）、编辑与加酬金、送达提交、雇主确认、撤销下架、撤销后申请退券（返还 1 张发布券） |
| 支付 | 固定 0.1 元信息服务费、三种支付模式（模拟 / 微信虚拟支付·发布券 / 微信支付 API v3）、发货推送与回调验签、撤销返还发布券 |
| 审核/申诉/举报 | 头像 / 昵称 / 校园认证审核、每日 2 条申诉、任务举报，均带管理员处理台 |
| 管理员封禁 | 恶意超时投诉直达管理员；封禁 / 加时 / 解封（5分钟、15分钟、30分钟、1小时、2小时、1天、自定义年月日时分秒） |
| 消息与账单 | 站内消息分类、一键已读；纯记账收支账单（无提现） |
| 定时任务 | 超时自动扣酬金、自动确认、解禁接单、解除登录锁定、申诉计数重置、驳回图片清理、垃圾文件清理 |

### 1.2 架构分层

```
routes 路由层  ->  controllers 控制器层  ->  models 数据访问层  ->  db 连接池
                      |                          |
                  utils 工具（字典/鉴权/加密/短信/支付）
                  middleware（JWT 鉴权 / 限流 / XSS 过滤）
                  schedule 定时任务（node-schedule 常驻）
```

硬性约束（全部已落实）：

- 所有 SQL 使用参数化占位符 `?`，禁止字符串拼接；`multipleStatements: false`。
- 所有多步写操作走 `db.transaction()`，失败自动回滚。
- 所有关键操作幂等：内存幂等键 + 数据库条件更新（`WHERE status=?`）双保险。
- 管理员权限只认后端硬编码学号白名单（`ADMIN_STUDENT_IDS`），**不读数据库 `is_admin` 字段**。
- 错误只返回友好文案，堆栈仅进服务端日志。

### 1.3 目录结构

```
<项目根目录>
├── backend
│   ├── .env / .env.example        环境变量
│   ├── package.json
│   ├── sql/init.sql               9 张表建表脚本
│   ├── scripts/
│   │   ├── checkAll.js            模块加载 + 纯函数自检
│   │   ├── checkMiniProgram.js    小程序编译层自检（JS/JSON/WXML/WXSS）
│   │   ├── checkMiniProgramBindings.js  小程序结构层自检（事件方法/数据字段/class/@import）
│   │   ├── checkPageRuntime.js    小程序模块层自检（require 每个页面 + Page() 能否执行）
│   │   ├── checkPageLifecycle.js  小程序生命周期层自检（onLoad/onShow 实跑抓异常）
│   │   ├── checkPageIntegration.js 小程序全功能联调（真实后端 + 真实账号跑 19 个页面）
│   │   ├── scheduleTest.js        定时任务行为测试（47 项）
│   │   ├── regression-*.js        业务回归脚本（业务全流程 / 发布券退券 / 账号安全 / 管理员 / 图片签名 / 消息角标 / 顶号 / 垃圾清理 / 抢单并发）
│   │   ├── ~~smokeTest.js~~       已停用（基于旧「短信验证码」账号体系）
│   │   ├── ~~apiCoverageTest.js~~ 已停用（同上）
│   │   ├── resetTestData.js       清空业务数据（重跑测试前用）
│   │   └── cleanForLaunch.js      上线前数据清洁（保留管理员，业务数据全清 + 假设备记录）
│   │   ├── fixRegionGarbled.js    修复「登录地点乱码」历史数据（按 IP 重新解析）
│   ├── uploads/                   图片存储目录（静态暴露 /uploads/*）
│   └── src
│       ├── app.js                 入口（中间件顺序 / 路由挂载 / 统一错误处理）
│       ├── db/db.js               连接池 + query/execute/transaction
│       ├── middleware/            auth.js / rateLimit.js / xssFilter.js / mediaGuard.js
│       ├── models/                User Task AuditApply Appeal Message Report Payment Bill
│       ├── controllers/           8 个业务控制器
│       ├── routes/                8 个路由文件
│       ├── schedule/index.js      8 个定时任务
│       └── utils/                 constant common bcryptUtil jwtUtil payUtil captchaUtil mediaSign secretGuard garbageCleaner
├── miniprogram
│   ├── app.js / app.json / app.wxss
│   ├── components/taskCard/       任务卡片组件
│   ├── images/tab/                tabBar 图标（8 个 PNG，81x81）
│   ├── pages/                     14 个页面（含 admin 管理后台）
│   └── utils/                     constant.js（与后端完全一致） request.js filter.js preview.js
└── tools
    └── make_tab_icons.py          tabBar 图标生成脚本（Python + Pillow，可重跑改色）
```

---

## 二、本地环境准备（Windows）

> 以下每一项都先「检查是否已安装」，已安装则跳过，未安装再执行安装命令。

### 2.1 Node.js（要求 >= 18，实测 v24.16.0）

```powershell
# 检查
node -v
npm -v
```

未安装时二选一：

```powershell
# 方式一：winget（Windows 10/11 自带）
winget install OpenJS.NodeJS.LTS

# 方式二：官网下载 LTS 安装包（勾选 Add to PATH）
# https://nodejs.org/zh-cn/download
```

安装完成后**重开一个终端**再执行 `node -v` 验证。

### 2.2 MySQL 8.0

```powershell
# 检查服务是否在运行
Get-Service -Name MySQL*
# 检查命令行客户端
mysql --version
```

未安装时：

```powershell
# 方式一：winget
winget install Oracle.MySQL

# 方式二：官网 MySQL Installer 8.0（选择 MySQL Server 8.0 + MySQL Workbench）
# https://dev.mysql.com/downloads/installer/
```

安装时务必记住 root 密码；本项目 `backend/.env` 的 `DB_PASSWORD` 已填写本机密码。

若本机 root 密码与 `.env` 不一致，用下面任一方式改密码：

```powershell
# 方式一：MySQL 命令行（需管理员身份运行）
mysql -u root -p
ALTER USER 'root'@'localhost' IDENTIFIED BY '新密码';
FLUSH PRIVILEGES;
```

```powershell
# 方式二：直接改 backend\.env 的 DB_PASSWORD
```

### 2.3 导入数据库（9 张表）

```powershell
cd <项目根目录>\backend

# 1) 建库（字符集必须是 utf8mb4）
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS campus_errand DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"

# 2) 导入 9 张表
mysql -u root -p campus_errand < sql\init.sql

# 3) 校验（应输出 9 张表）
mysql -u root -p -e "USE campus_errand; SHOW TABLES;"
```

预期表清单：`users`、`tasks`、`audit_apply`、`appeals`、`messages`、`report`、`payments`、`user_bill`、`sms_code`。

### 2.4 安装后端依赖

```powershell
cd <项目根目录>\backend
npm install
```

> `bcrypt` 为可选原生依赖（`optionalDependencies`），若编译失败会自动降级使用纯 JS 的 `bcryptjs`，不影响运行。

---

## 三、.env 环境变量完整说明

文件位置：`backend/.env`（模板见 `backend/.env.example`）

| 变量 | 说明 | 本地开发值 |
| --- | --- | --- |
| `PORT` | 后端监听端口 | `3000` |
| `NODE_ENV` | 运行环境 | `development` |
| `DB_HOST` / `DB_PORT` | MySQL 地址 / 端口 | `localhost` / `3306` |
| `DB_USER` / `DB_PASSWORD` | MySQL 账号 / 密码 | `root` / 本机密码 |
| `DB_NAME` | 数据库名 | `campus_errand` |
| `JWT_SECRET` | 双令牌签名密钥，**上线必须换成随机长串** | 开发用默认值 |
| `JWT_ACCESS_EXPIRES` | access_token 有效期 | `2h` |
| `JWT_REFRESH_EXPIRES` | refresh_token 有效期 | `7d` |
| `ADMIN_STUDENT_IDS` | 管理员学号白名单，逗号分隔；**后台权限唯一来源** | `20240001,20240002` |
| `PAY_MODE` | 支付模式总开关：`simulate` 模拟支付（点支付即成功，不调微信）/ `virtual` 微信小程序虚拟支付（个人主体 B 方案，卖「发布券」道具）/ `api_v3` 微信支付 API v3（企业商户号方案，代码保留备用） | `simulate` |
| `PAY_SIMULATE` | 兼容旧配置：只有 `PAY_MODE` 未设置时才读它（`true`→simulate，`false`→api_v3） | `true` |
| `WX_APPID` | 小程序 AppID（正式支付必填） | 占位 |
| `WX_APP_SECRET` | 小程序 AppSecret，用于 code 换 openid | 占位 |
| `WX_MCH_ID` | 微信支付商户号 | 占位 |
| `WX_API_V3_KEY` | APIv3 密钥（回调解密） | 占位 |
| `WX_MCH_SERIAL_NO` | 商户 API 证书序列号 | 占位 |
| `WX_CERT_PATH` / `WX_KEY_PATH` | 商户证书 / 私钥路径 | `./cert/*.pem` |
| `WX_PLATFORM_CERT_PATH` | 微信支付平台证书（回调验签） | `./cert/wechatpay_platform_cert.pem` |
| `WX_NOTIFY_URL` | 微信支付 API v3 回调公网地址（备用通道），必须是 HTTPS | 占位 |
| `XPAY_OFFER_ID` | 虚拟支付商户号 OfferID（开通虚拟支付后获得） | 空 |
| `XPAY_APP_KEY` | 虚拟支付现网 AppKey（用于 paySig 签名） | 空 |
| `XPAY_COUPON_PRODUCT_ID` | 「发布券」道具 ID（虚拟支付后台建道具时使用的编号） | `publish_coupon` |
| `XPAY_COUPON_PRICE_FEN` | 单张发布券价格（分），必须与后台道具单价完全一致 | `10`（0.1 元） |
| `WX_SUBSCRIBE_ORDER_TEMPLATE` | 订阅消息模板 ID（「订单进度通知」）；留空则不下发 | 项目自带模板 |
| `WX_SUBSCRIBE_STATE` | 订阅消息声明的小程序版本：`developer` / `trial` / `formal` | `formal` |
| ~~`SMS_MOCK`~~ / `SMS_ACCESS_KEY` 等 | **短信通道已整体下线**（注册 / 登录 / 找回改用图形验证码 + 密保），此组为历史占位配置，保持原样即可 | `true` / 占位 |
| `SMS_ACCESS_KEY` / `SMS_ACCESS_SECRET` | 阿里云短信 AK/SK | 占位 |
| `SMS_SIGN_NAME` / `SMS_TEMPLATE_CODE` | 短信签名 / 模板 CODE | 占位 |
| `UPLOAD_MAX_SIZE` | 单张图片最大字节数 | `2097152`（2MB） |
| `SERVICE_FEE` | 信息服务费 | `0.10` |
| `EDIT_INTERVAL_MIN` | 两次编辑/加酬金最小间隔（分钟） | `3` |
| `CANCEL_TAKE_MIN` | 接单后可取消的时间窗（分钟） | `10` |
| `SCHEDULE_TICK_SEC` | 定时任务扫描节拍（秒） | `60` |
| `SEC_CHECK_ENABLE` | `true` 开启微信内容安全：用户填写的任务备注、昵称、举报理由会送 `msg_sec_check` 校验，命中违规直接拒绝 | `false` |
| `SEC_CHECK_FAIL_MODE` | 微信侧校验接口异常时的兜底策略：`closed` 拦截（更安全，用户会看到「校验服务暂时不可用」）/ `open` 放行（更可用） | `open` |
| `CAPTCHA_HOURLY_LIMIT` / `ACCOUNT_HELPER_HOURLY_LIMIT` / `REGISTER_IP_HOURLY_LIMIT` / `SECURITY_HOURLY_LIMIT` | 同一 IP 每小时的接口调用上限（图形验证码 / 账号ID辅助 / 注册 / 密保） | `60` / `120` / `100` / `60` |
| `MEDIA_URL_WINDOW_HOURS` | 图片地址签名有效期（小时），过期后前端需重新拉接口换取新签名 | `6` |
| `CLEAN_ENABLED` / `CLEAN_DRY_RUN` | 垃圾清理总开关 / 空跑模式（只输出待清理清单，不真删） | `true` / `false` |
| `CLEAN_ORPHAN_KEEP_DAYS` / `CLEAN_TRASH_KEEP_DAYS` / `CLEAN_LOG_KEEP_DAYS` / `CLEAN_SMS_KEEP_DAYS` | 孤立图片 / 回收站图片 / 日志 / 短信记录 的保留天数 | `7` / `3` / `7` / `7` |
| `CLEAN_LOG_MAX_MB` / `CLEAN_LOG_KEEP_LINES` | 单个日志文件切割阈值（MB）与切割后保留行数 | `20` / `2000` |

> 本地调试时 `PAY_MODE=simulate`（默认），无需任何微信 / 阿里云账号即可跑通全流程。
> 上线前必须把 `PAY_MODE` 改成 `virtual`（个人主体虚拟支付）或 `api_v3`（企业商户号），并替换 `JWT_SECRET` 与各项证书 / 密钥。
> 服务启动时会做「上线自检」：`PAY_MODE=simulate`、`SEC_CHECK_ENABLE=false`、弱数据库口令等都会在日志里逐条告警。
> `SMS_*` 一组已随短信通道下线，无需配置（图形验证码由服务端本地生成，零成本）。
---

## 四、启动后端与自检

### 4.1 启动服务

```powershell
cd <项目根目录>\backend

# 前台启动（Ctrl+C 停止）
npm start
# 或： node src/app.js
```

后台启动（不占用当前终端）：

```powershell
Start-Process -FilePath 'node' -ArgumentList 'src/app.js' -WorkingDirectory '<项目根目录>\backend' -WindowStyle Hidden
```

启动成功日志：

```
[INFO] 数据库连接成功：root@localhost:3306/campus_errand
[INFO] 定时任务已启动：超时扣酬金 / 自动确认 / 解禁接单 / 解除登录与密保锁定 / 申诉计数重置 / 驳回图片清理 / 免费代拿过期清理 / 垃圾文件清理
[INFO] 校园跑腿后端服务已启动：http://localhost:3000
[INFO] 支付模式：模拟支付；短信模式：模拟短信
```

健康检查：

```powershell
curl http://127.0.0.1:3000/api/health
# {"code":200,"msg":"成功","data":{"status":"ok",...}}
```

### 4.2 端到端自检（强烈建议首次部署后执行）

```powershell
cd <项目根目录>\backend

# 0) 模块加载 + 纯函数断言
node scripts\checkAll.js

# 1) 业务全流程回归（123 项断言：注册/密保/校园认证/发布支付/并发接单/取消接单/加酬金
#    送达照片强制校验/确认送达自动记账/撤销退券/举报/邀请码免费代拿/管理员封禁/越权校验）
#    （另有 node scripts/regression-coupon-pay.js：发布券与退券专项 32 项）
node scripts\regression-business-flow.js

# 2) 账号体系专项（36 项断言：图形验证码 / 自选账号ID / 密保设置与校验 / 换设备密保解锁 / 密保找回密码）
node scripts\regression-account-security.js

# 3) 管理员身份与登录通道 + 管理员订单管理（26 项断言：学号 / 账号ID / 统一错误提示防账号枚举 /
#    订单搜索·编辑·处罚·删除 / 已删除订单检索与冻结）
node scripts\regression-admin-login.js

# 4) 定时任务真实行为（44 项断言：超时扣酬金 / 超时自动确认并记账 / 封禁解禁 / 登录解锁 /
#    申诉计数重置 / 7 天前驳回图片清理）
node scripts\scheduleTest.js

# 5) 上传图片访问签名 + 密钥强度（28 项断言：未签名访问 403 / 签名篡改与过期被拒 /
#    接口下发的地址自动带签名 / 带签名地址回传后被剥成裸路径入库）
node scripts\regression-media-security.js

# 6) 垃圾清理器安全性（39 项断言：白名单与扩展名护栏 / 引用保护 / 时间闸门 /
#    回收站两步删除 / 清理后核心文件与数据库数据完好）
node scripts\regression-garbage-cleaner.js

# 6.5) 顶号提示 + 设备登录地点 + 已删除任务拦截（21 项断言：旧设备被顶下线后返回
#      401 + data.kicked，提示含「新设备名称 / 时间 / IP / 归属地」；重复请求仍返回完整
#      提示内容（记录不再被提前消费）；登录 IP 确实落库（非空）；设备列表返回 loginIp /
#      loginRegion；管理员已删除任务的 actions 全部为 false，前端不再出现接单按钮）
node scripts\regression-kick-device.js

# 6.6) 消息中心「详情 + 一键清除未读」与「我的任务」Tab 角标（28 项断言：消息详情按
#      归属校验越权 / 打开即标记已读且幂等 / 清除未读只影响本人且重复清除返回 0 /
#      tabBadge 只统计「进行中 + 待雇主确认」，不含已完成与已取消）
node scripts\regression-message-badge.js

# 6.7) 并发接单专项（20 项断言：5 人同一瞬间抢同一个任务，
#      恰好 1 人成功、其余 4 人 409「任务已被他人接单」；落库只有
#      一个接单人；雇主只收到 1 条接单消息；失败方详情页 canTake=false
#      且看到真正接单人；连点与事后重试均被拒）
node scripts\regression-take-race.js

# 7) 管理员自动认证 / 管理员标识自检（随时可跑，不修改任何数据）
node scripts\checkAdminStatus.js

# 8) 清理回归测试残留账号（回归脚本会自行清理；--dry-run 先看会删哪些，不实际删除）
node scripts\cleanTestData.js --dry-run

# 9) 垃圾文件清理（每天 03:00 自动跑，也可手动执行；先用 --dry-run --list 看清单）
node scripts\cleanGarbage.js --dry-run --list

# 7) 一键创建一套可直接登录的测试账号（账号ID / 学号 / 密码会打印在控制台）
node scripts\createTestAccounts.js

# 8) 清空全部业务数据 + 一键创建指定管理员账号（⚠ 会删数据，仅限全新部署时使用）
node scripts\initAdmin.js
```

> 📌 旧脚本 `smokeTest.js` / `apiCoverageTest.js` 基于**已下线的「手机号 + 短信验证码」账号体系**，
> 现已停用：直接运行只会打印迁移提示并退出（如需强行运行可设 `FORCE_LEGACY_SMS_TEST=1`，
> 但它们预期会大量失败）。上面的 1~4 号脚本已完整覆盖业务规则与账号体系。
> 回归脚本会自动清理自己创建的测试账号；若中途异常中断留下残留，执行
> `node scripts\cleanTestData.js` 即可按「测试昵称 / 测试学号 / 脚本生成的测试手机号」精确清理。

> ⚠️ 正式库 `campus_errand` 已含真实测试数据，**不要**在上面执行 `resetTestData.js`。
> 推荐用「独立测试库」跑回归测试，全程不影响正式数据：
>
> ```powershell
> # 0) 若 3100 测试实例正在运行，先停掉（重建库会让它的连接失效）
> Get-NetTCPConnection -LocalPort 3100 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
>
> # 1) 创建 / 重建测试库 campus_errand_test（表结构与正式库完全一致）
> node scripts\initTestDb.js
>
> # 2) 另开一个后端实例：连测试库、监听 3100 端口（正式服务继续跑 3000）
> $env:PORT='3100'; $env:DB_NAME='campus_errand_test'; node src/app.js
>
> # 3) 新开一个终端，把测试脚本指向 3100（scheduleTest 需同时指定测试库）
> $env:SMOKE_BASE='http://127.0.0.1:3100'; node scripts\smokeTest.js
> $env:DB_NAME='campus_errand_test'; $env:SMOKE_BASE='http://127.0.0.1:3100'; node scripts\scheduleTest.js
> ```
>
> 注意：接口限流是「后端进程内存」实现，同一分钟内重复跑 `smokeTest` 会提示
> 「发布过于频繁，请稍后再试」，重启 3100 实例即可清零。

测试账号说明（新版账号体系）：

- 回归脚本会**自己注册临时账号**（账号ID 随机、手机号用脚本生成的测试号、统一密码 `abc123456`），
  并在跑完后**自动清理**（连同任务 / 账单 / 消息 / 审核记录 / 设备记录一起删干净），不会污染正式库；
  中途异常中断留下的残留用 `node scripts\cleanTestData.js` 清理。
- 想在真机/开发者工具里手工登录测试，用 `node scripts\createTestAccounts.js` 一键创建，
  控制台会打印**账号ID / 学号 / 手机号 / 密码 / 密保答案**。
- **正式库** `campus_errand` 当前保留的管理员账号：

  | 账号编号 | 手机号 | 学号 | 密码 | 说明 |
  | --- | --- | --- | --- | --- |
  | `A0001` | `你的管理员学号` | `你的管理员学号` | `见 backend/.env 的 INIT_ADMIN_PASSWORD` | 管理员，学号命中 `.env` 里的 `ADMIN_STUDENT_IDS`，自动校园认证 + 管理员标识、免密保限制 |

  > 说明：本 README 里的手机号 / 学号 / 密码 / 内网穿透域名 / AppID 一律为占位符，
  > 真实值只保存在本机 `backend/.env`（已被 `.gitignore` 忽略，不会上传）。

- 登录页「账号」输入 `A0001`、`a0001`、`你的管理员学号`（学号或手机号）都能命中同一账号；
  普通用户注册时**自己选账号ID**（`X` 前缀 + 1~4 位数字，可点「随机生成」），详见 5.7 与 5.12。

### 4.3 定时任务

使用 `node-schedule` 随服务常驻，**不依赖前端触发**：

| 频率 | 任务 |
| --- | --- |
| 每分钟 | 限时任务超时未完成 -> 自动扣减 5% 酬金（**任务不取消**，仍可继续送达；**不自动封禁**） |
| 每分钟 | 待雇主确认超 2 小时 -> 自动确认完成 + 生成「任务收入」账单 |
| 每分钟 | `ban_take_time` 到期 -> 自动解禁接单 |
| 每分钟 | `login_lock_time` 到期 -> 自动解除登录锁定并清零错误次数 |
| 每天 00:00 | 重置当日申诉提交计数 |
| 每天 01:00 | 清理 7 天前审核驳回的图片文件（含路径穿越防护） |
| 每天 02:00 | 清零已过期的「邀请码免费代拿」次数（展示口径归零，业务判定始终看有效期） |
| 每天 03:00 | 垃圾文件清理：孤立上传图片 / 过期日志 / 短信表历史记录（详见 4.4） |
| 每天 04:00 | 顶号提示归档：只删除「30 天前且已读」的 `user_kick` 记录，未读记录一律保留 |

### 4.4 垃圾文件自动清理

每注册并使用一个用户，服务器上都会多出两类东西：**上传的图片**与**运行日志**。
其中真正「只用不删、越积越多」的是**孤立图片**：

- 用户上传后放弃提交（退出发布页 / 关掉小程序）留下的图片
- 换过头像之后，再也没有人引用的旧头像
- 账号注销时头像 / 认证截图字段被清空，文件却还留在磁盘上
- 管理员删除任务后，该任务的照片全部变成无主文件

这些文件不会再被任何页面引用，却会一直占着磁盘。系统每天 **03:00** 自动清理一次：

| 清理对象 | 规则 |
| --- | --- |
| 孤立上传图片 | 数据库无任何记录引用 **且** 修改时间超过 `CLEAN_ORPHAN_KEEP_DAYS`（默认 7 天）-> 移入 `uploads\.trash` 回收站；在回收站滞留超过 `CLEAN_TRASH_KEEP_DAYS`（默认 3 天）才真正删除 |
| 日志文件 | 超过 `CLEAN_LOG_KEEP_DAYS`（默认 7 天）的 `.log` 直接删除；单个文件超过 `CLEAN_LOG_MAX_MB`（默认 20MB）时只保留最后 `CLEAN_LOG_KEEP_LINES` 行 |
| 数据库 | 短信验证码表 `sms_code` 中过期 / 已使用的历史记录（短信通道已下线，该表只剩历史数据） |

**为什么不会误删核心文件**（`src/utils/garbageCleaner.js` 里的九道护栏）：

1. **白名单根目录**：只允许触碰 `uploads\`、`backend\logs\`、`logs\` 三处，其它任何路径一律拒绝
2. **扩展名白名单**：`uploads` 只处理 `.jpg/.jpeg/.png/.webp`，日志只处理 `.log`（源码 / 配置 / 证书天然被排除）
3. **路径包含校验**：删除前用 `path.relative` 复核目标确实位于白名单目录内，防 `..` 穿越与软链接外指
4. **敏感目录黑名单**：路径中出现 `src`、`node_modules`、`scripts`、`cert`、`miniprogram`、`models`、`controllers` 等片段直接跳过
5. **引用保护**：仍被数据库任何记录引用的图片永远不删，哪怕文件已经很老
6. **时间闸门**：只处理超过保留期的文件，刚上传、正在提交表单中的业务图片绝不会被碰到
7. **两步删除**：先移入回收站、滞留期满才真删，判断失误也能人工救回
8. **空跑模式**：`CLEAN_DRY_RUN=true` 时只统计不删除
9. **不删目录**：只删文件，绝不删除任何目录结构

手动执行 / 预览（建议先空跑看一遍清单）：

```powershell
cd <项目根目录>\backend
node scripts\cleanGarbage.js --dry-run --list   # 只统计并列出待回收文件，不做任何改动
node scripts\cleanGarbage.js --apply            # 按 .env 配置真正执行一轮
node scripts\cleanGarbage.js --days=3 --list    # 临时把「孤立图片保留期」改成 3 天
```

> **关于后端日志**：cmd 的 `>>` 重定向会把日志文件独占锁定，运行期间任何程序都删不掉它
> （Windows 返回 `EBUSY`）。因此守护脚本已改为**按天分文件** `backend\logs\server-yyyyMMdd.out.log`，
> 一旦重启就换用新文件，旧文件被释放后即可被每天 03:00 的清理任务回收。
---

## 五、微信开发者工具配置

### 5.1 导入项目

1. 下载安装「微信开发者工具」（稳定版）：<https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html>
2. 打开工具 -> **导入项目**
   - 目录：`<项目根目录>\miniprogram`
   - AppID：填自己的小程序 AppID（`project.config.json` 中当前为 `wx0000000000000000`，请替换为本人 AppID；纯本地调试可选用「测试号」）
3. 若提示域名不合法：**详情 -> 本地设置 -> 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**
   （`project.config.json` 中已默认 `"urlCheck": false`）

### 5.2 后端地址配置

小程序默认请求 `http://localhost:3000`（见 `miniprogram/utils/request.js`）。

- 模拟器调试：无需修改，`localhost` 直连本机后端。
- 真机预览（手机与电脑同一 WiFi）：把 `localhost` 换成本机内网 IP，例如 `http://192.168.1.100:3000`。
- 真机 + 公网：使用 cpolar 域名（见第六节）。

两种修改方式（任选其一）：

```javascript
// 方式一：直接改 miniprogram/utils/request.js 的 BASE_URL
// 本机模拟器调试用 http://localhost:3000；真机/他人体验版用 cpolar 的 https 域名
let BASE_URL = 'https://你的域名';
```

```javascript
// 方式二：不改代码，在开发者工具 Console 执行一次（写入本地缓存，重编译仍生效）
wx.setStorageSync('BASE_URL', 'https://你的cpolar域名')
```

手机真机访问时需放行 Windows 防火墙 3000 端口（管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "Node3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

### 5.3 页面与 Tab 结构

底部 4 个固定 Tab：**首页（任务大厅） / 我的发布 / 我的任务 / 我的**。

图标资源位于 `miniprogram/images/tab/`，共 8 个 81x81 透明 PNG（4 组「常态 + 选中」），
常态色 `#8a8f99`、选中色 `#2b7efb`，与 `app.json` 中 `tabBar.color` / `selectedColor` 一致：

| Tab | 常态图标 | 选中图标 |
| --- | --- | --- |
| 首页 | `images/tab/home.png` | `images/tab/home-active.png` |
| 我的发布 | `images/tab/publish.png` | `images/tab/publish-active.png` |
| 我的任务 | `images/tab/task.png` | `images/tab/task-active.png` |
| 我的 | `images/tab/profile.png` | `images/tab/profile-active.png` |

需要换配色或改尺寸时，直接改 `tools/make_tab_icons.py` 顶部的 `COLOR_NORMAL` / `COLOR_ACTIVE` / `SIZE`，
再执行 `python tools\make_tab_icons.py` 重新生成即可（依赖 Python + Pillow，非小程序运行依赖）。

| 页面路径 | 说明 |
| --- | --- |
| `pages/index/index` | 任务大厅（分页、排序、筛选；顶部「未完成任务」牌堆 = 我发布的 + 我接的 待接单/进行中/待确认，上下滑动切换，主体下拉刷新） |
| `pages/myPublish/myPublish` | 我的发布（按状态分组、编辑、撤销、加酬金、已撤销任务申请退券） |
| `pages/myTake/myTake` | 我的任务（接单列表、上传送达照片、提交完成） |
| `pages/profile/profile` | 我的（醒目展示四位补零账号 ID，标注「可用于登录」） |
| `pages/login/login` | 登录（单输入框自动识别账号 ID 或学号；底部小字跳注册 / 忘记密码） |
| `pages/register/register` | 注册（自选账号 ID + 随机生成 + 图形验证码 + 密保问题 + 协议勾选） |
| `pages/forgot/forgot` | 忘记密码（两步式：账号ID + 图形验证码 -> 密保问题 -> 重置密码） |
| `pages/devices/devices` | 我的设备（每台设备展示登录时间与 IP / 归属地） |
| `pages/securitySetup/securitySetup` | 密保问题设置与修改（每题竖排：上方问题、下方答案） |
| `pages/securityUnlock/securityUnlock` | 换设备登录时的密保解锁页 |
| `pages/publishTask/publishTask` | 发布任务（表单 + 预设模板 + 支付唤起） |
| `pages/taskDetail/taskDetail` | 任务详情（雇主/接单者双视角，确认送达 3 秒倒计时弹窗） |
| `pages/taskEdit/taskEdit` | 编辑任务（待接单全量编辑 / 进行中仅调酬金） |
| `pages/message/message` | 消息中心（分类、一键已读） |
| `pages/campusCert/campusCert` | 校园认证提交 |
| `pages/auditApply/auditApply` | 头像 / 昵称修改申请 |
| `pages/appeal/appeal` | 申诉提交与记录 |
| `pages/bill/bill` | 收支账单（纯查看，无提现入口） |
| `pages/admin/admin` | 管理员后台（审核 / 申诉 / 举报 / 封禁 / 用户，仅白名单可见） |

### 5.4 管理员入口

用白名单学号注册的账号（默认 `20240001`、`20240002`）登录后，「我的」页面会显示「管理员后台」入口。
前端入口只是展示层开关，**真正的权限由后端 `adminAuth` 中间件按学号白名单逐次校验**。

管理员后台共 6 个 Tab：**审核管理 / 申诉管理 / 举报管理 / 订单管理 / 封禁管理 / 用户管理**
（其中「订单管理」详见 5.13）。

**管理员账号的两条自动规则**（凡学号命中 `ADMIN_STUDENT_IDS` 白名单）：

1. **自动校园认证**：白名单账号无需提交任何认证申请，注册 / 登录 / 后端启动时会被自动置为
   `is_campus_audit = 2`（校园认证通过），因此可直接发布任务、接单。
   - `models/User.js` → `autoCertifyAdmin()`：注册、登录、每次鉴权时按需修正（已是目标状态则不产生写操作）
   - `models/User.js` → `syncAdminAccounts()`：后端启动时批量同步，重启即刻生效
   - 后端启动日志会打印：`管理员账号同步完成，本次修正 N 个账号（白名单：...）`
2. **管理员标识对所有人可见**：白名单账号自动带 `is_admin = 1` 与 `roleTag = "管理员"`。
   - 「我的」页面：昵称旁 + 「账号身份」行显示管理员标签，校园认证显示「管理员自动认证」
   - 任务大厅卡片、任务详情、我的发布 / 我的任务：雇主 / 跑腿员名字后显示管理员标签
   - 管理员接单时推送给雇主的站内消息，昵称带「管理员·」前缀

> 安全口径不变：`users.is_admin` **只用于展示**，所有管理员接口权限仍由 `adminAuth`
> 中间件按 `.env` 白名单逐次校验；即使有人非法把数据库 `is_admin` 改成 1，也拿不到任何后台权限。

### 5.5 如何让其他人随时随地访问

「预览」二维码本质是**开发版**，微信给它设了有效期（约 25 分钟），且只能由项目成员扫码，不适合长期分享给测试者。长期可用的方式有两种：

**方式一：体验版（内测阶段推荐）**

1. 开发者工具右上角 **上传** → 填版本号（如 `1.0.2`）
2. mp.weixin.qq.com → **管理 → 版本管理** → 在「开发版本」里点 **选为体验版本**
3. **管理 → 成员管理 → 体验成员** → 把测试者微信号加进去（人数有上限，几十人内）
4. 把版本管理页的**体验版二维码**发给测试者，扫一次即可长期使用；
   测试者也可以把体验版「添加到我的小程序」，之后随时打开

> 体验版二维码**不会过期**，只要不更换体验版就一直有效。
> 注意：每个测试者必须先被加为「体验成员」，否则扫码会提示无权限。

**方式二：正式发布（真正的随时随地）**

1. mp.weixin.qq.com → **管理 → 版本管理** → 把开发版本 **提交审核**（一般 1~2 个工作日）
2. 审核通过后点 **发布**
3. 发布后任何人无需加成员：微信搜索小程序名、扫码、好友分享都能直接进入

> 发布的前提：`request 合法域名` 已配置（域名需 ICP 备案），且后端 **7×24 在线**。

**最关键的前提：域名和服务器必须固定**

- cpolar 免费版的隧道域名**每次重建隧道都可能变化**，域名一变小程序所有请求就会失败
- 解决路径：
  - 用 cpolar 付费版申请**固定二级域名**（形如 `xxx.cpolar.cn`，主域名已备案，大概率能通过微信备案校验）
  - 或迁移到**云服务器 + 已备案域名**（见第七章，最稳、最适合长期分享）

**排查真机网络问题的隐藏入口**

登录页顶部「跑」图标 **长按** 会弹出「后端连接自检」，显示当前请求的后端地址与实际结果，
用于快速区分「域名没配」和「服务没起」两类问题。
---

### 5.6 图片上传通道（主通道 + 备用通道）

小程序里所有需要上传图片的地方（校园认证截图、头像、任务图片、送达照片）统一走 `utils/request.js` 的 `chooseAndUpload()`：

| 环节 | 处理方式 |
| --- | --- |
| 压缩 | 除 `wx.chooseMedia` 的 `compressed` 外，超过 2MB 会自动 `wx.compressImage` 再压两轮（quality 70 → 40） |
| 超限 | 压缩后仍超 2MB 会明确提示「图片超过2MB，请重新选择或先裁剪」，**绝不静默失败** |
| 主通道 | `POST /api/user/uploadImage`（`wx.uploadFile`，multipart/form-data） |
| 备用通道 | 主通道失败时自动改用 `POST /api/user/uploadImageBase64`（base64 + `wx.request`），该路由请求体上限放宽到 8MB |
| 错误码 | 全部失败抛 `-3`（页面弹提示）；用户主动取消抛 `-100`（静默忽略） |
| 删除重选 | 已上传的缩略图右上角有 × 按钮，可删除后重新上传 |

> 真机排查：控制台若出现 `uploadFile:fail url not in domain list`，说明只配了 **request 合法域名**，
> 还需要在 mp 后台把同一个域名加到 **uploadFile 合法域名**。未配置时备用通道会兜底成功（走 `wx.request`）。

### 5.7 账号编号规则与「在哪里查看用户数据」

#### 账号编号规则（对外唯一标识）

数据库主键 `users.id` 仍是 `INT AUTO_INCREMENT`（全局唯一、并发安全），
但**对外展示与登录**统一使用 `users.account_no` 账号编号：

| 角色 | 账号编号 | 登录时可用 | 说明 |
| --- | --- | --- | --- |
| 管理员 | `A0001`（固定） | `A0001` / `你的管理员学号`（学号）/ `你的管理员学号`（手机号） | 由「账号管理工具.bat」创建，学号命中 `ADMIN_STUDENT_IDS` 自动认证 |
| 普通用户 | 注册时自己选（如 `X0001`） | 账号ID / 学号 / 1~5 位内部编号 | 注册页填 `X` + 1~4 位数字；点「随机生成」按钮可自动挑一个没被占用的号 |

- 登录页「账号」输入框四种写法都能定位到同一个账号：
  ① 账号ID `A0001` / `X0001`（大小写不限）；
  ② 学号（6 位及以上纯数字优先按学号匹配，如 `202502084`）；
  ③ 1~5 位纯数字按内部编号（自动去前导零，`0001` / `001` / `1` 都命中 id=1 的账号）；
  ④ 11 位手机号兜底（兼容只记得手机号的老账号）。
- 发号规则：普通用户账号ID 由**用户自己在注册页填写**（`X` 前缀锁定，后面 1~4 位数字自定），
  不足 4 位自动补零（填 `1` → `X0001`），超过 9999 直接显示原数字（`X10000`）；
  注册接口用数据库唯一索引兜底，重复会直接返回「该账号ID已被使用」，注册页的「随机生成」按钮会挑一个可用号。
  管理员账号 `A0001` 由「账号管理工具.bat」创建（注册接口不发放管理员号）。
- 老库自动升级：后端启动时会检查 `users.account_no` 列，缺失则自动添加并按 id 顺序回填历史账号，无需手工改表。

#### 查看用户数据的 4 个入口

1. **小程序管理员后台（最直观）**
  用管理员账号登录小程序 → 「我的」→「管理员后台」→ 用户管理，
  可查看每个用户的账号编号、头像、昵称、手机号、学号、认证状态、昵称修改次数、封禁状态与管理员标识，
  并可对其「封禁接单 / 加时封禁」或「修改资料」；
  「封禁管理」Tab 可按学号 / 手机号 / 账号ID 搜索被封禁人并解封或加时。
  对应接口：`GET /api/admin/userList`（支持 `keyword` 模糊搜索 + 分页）。
  封禁列表接口：`GET /api/admin/banList`。

  **管理员直接修改用户资料**（`POST /api/admin/updateUser`）：
  可改昵称 / 姓名 / 手机号 / 学号 / 校园认证状态 / 头像，保存成功后系统会自动向该用户
  推送一条「账号信息已被管理员修改」的站内消息（消息里逐项列出改动明细）。

  - 管理员后台的手机号是**完整显示**（用户端接口仍然是脱敏手机号 `138****0001`），便于核对身份、联系当事人；
  - 管理员账号自身同样可以被修改昵称 / 姓名 / 手机号 / 头像，但**学号被锁定不可改**
    （学号是管理员权限的唯一锚点，改掉会立刻丢失管理员权限）；
  - 任何账号的学号都**不允许**被改成 `ADMIN_STUDENT_IDS` 白名单里的学号（否则等于凭空造出管理员），命中直接返回 403；
  - 手机号全局唯一、认证通过的账号之间学号全局唯一，冲突分别返回 409；
  - 一次提交里没有任何字段发生变化时返回 409，不产生无意义的通知；
  - 管理员账号不受「昵称修改次数」「申诉每日 2 条」限制（用户管理里昵称剩余次数显示为「不限」）。

  **管理员重置用户登录密码**（`POST /api/admin/resetUserPassword`）：
  用户管理里点「重置密码」，可选「自动生成随机密码」（8 位，已剔除 0/O、1/l 等易混字符）
  或「手动指定新密码」（6-20 位）。重置成功后：

  1. 密码立即变为新密码（bcrypt 哈希入库，数据库不出现明文），响应里会把新密码返回给管理员，
     界面支持一键复制，方便转告该用户；
  2. 该用户的密码错误次数清零、登录锁定立即解除（被锁定的账号重置后可直接登录）；
  3. 该用户所有设备立即退出登录（设备标识被清空），必须用新密码重新登录；
  4. 系统自动推送站内消息「登录密码已被管理员重置」告知本人。

  日志只记录「谁重置了谁的密码」，绝不记录密码内容。

2. **MySQL 命令行**

   ```powershell
   mysql -u root -p campus_errand
   ```

   ```sql
   -- 全部用户概览
   SELECT id, account_no, phone, student_id, name, nickname,
          is_campus_audit, is_avatar_audit, is_admin, ban_take_time, last_login_time
     FROM users ORDER BY id;

   -- 登录 / 锁定 / 设备状态
   SELECT id, account_no, login_fail_count, login_lock_time, last_login_time, login_device_id FROM users;

   -- 校园认证申请记录（apply_type=3 为校园认证，=1 头像，=2 昵称）
   SELECT * FROM audit_apply WHERE apply_type = 3 ORDER BY id DESC;

   -- 某个人的任务与账单（把 1 换成目标 user_id 或账号编号对应的 id）
   SELECT * FROM tasks WHERE user_id = 1 OR taker_user_id = 1;
   SELECT * FROM user_bill WHERE user_id = 1 ORDER BY id DESC;
   ```

3. **图形化工具**：MySQL Workbench（装 MySQL 时勾选即可）、Navicat、DBeaver、phpMyAdmin。
   连接参数：主机 `localhost`、端口 `3306`、用户 `root`、
   密码见 `backend\.env` 的 `DB_PASSWORD`、数据库 `campus_errand`。

4. **想看某个人的明文密码？** 做不到也不需要：密码用 bcrypt 哈希后存放在 `users.password_hash`，
   数据库里永远没有明文；忘记密码只能走「手机号 + 短信验证码」重置。

> 一键清空 + 重建管理员：`cd backend` 后执行 `node scripts\initAdmin.js`
> （TRUNCATE 全部 9 张表：账号 / 认证 / 登录记录 / 任务 / 账单 / 消息全部清空，然后创建 `A0001`）。

### 5.8 任务列表 / 详情页展示字段与认证标识

#### 每条任务展示谁的信息

任务卡片（任务大厅、我的发布、我的任务）统一展示：

| 展示项 | 说明 |
| --- | --- |
| 发布者 | 头像、昵称、账号ID（A0001 / X0001）、学号 + 身份标识 |
| 接单者 | 头像、昵称、账号ID、学号 + 身份标识（「我的发布」中已有人接单时展示） |
| 送达地址 | 任务送达地址 |
| 限时 | 直接显示时长（如「30分钟」「2小时」），未设置限时显示「不限时」 |
| 跑腿费 | 劳务酬金（线下转账） |
| 备注 / 收件人 / 发布时间 | 卡片底部一行展示 |

点进**任务详情页**后再加载全部信息：相关人员（发布者 + 接单者）的头像 / 昵称 / 账号ID / 学号 / 标识、
收件人手机号（仅双方便于联系）、任务图片、送达照片、各时间节点与全部操作按钮。

**头像点击看大图**：全站所有展示头像的位置（任务卡片、任务详情「相关人员」、我的发布 / 我的任务、
个人中心、管理员后台用户列表）都支持点头像弹出大图预览，统一走 `miniprogram/utils/preview.js`
的 `previewImage()`；未上传头像的用户点击无反应，不会弹出空白预览。卡片内的头像用 `catchtap`
拦住冒泡，因此点「头像」只预览、不会顺带跳进任务详情。

**状态标签配色**：牌堆卡上的「待接单 / 进行中 / 待雇主确认」用不同颜色区分（蓝 / 橙 / 紫；
已完成绿、超时取消红、雇主撤销灰），深色卡上统一用同色系半透明底 + 同色系描边 + 浅色文字。
颜色槽位与列表卡的左侧色条同源，都来自 `miniprogram/utils/filter.js` 的 `taskAccentClass()`；
牌堆标签类名由同文件的 `taskDeckStatusClass()` 产出，将来新增状态只改这一处映射即可全站生效。

#### 认证标识规则（绿色「已认证」/ 红色「管理员」）

| 用户身份 | 展示标识 | 样式 |
| --- | --- | --- |
| 管理员（学号命中 `ADMIN_STUDENT_IDS` 白名单） | 红色「管理员」 | `.tag-admin`（红色底 + 红字） |
| 校园认证通过的普通用户 | 绿色「已认证」 | `.tag-success`（绿色底 + 绿字） |
| 未认证 / 待审核 / 已驳回 | 不显示任何标识 | - |

> 管理员**不再显示「已认证」**，只显示红色管理员标识（管理员账号本身自动具备认证权限）。

唯一判定出口：`miniprogram/utils/filter.js` 的 `identityBadge(isAdmin, isCertified)`；
文案字典在 `miniprogram/utils/constant.js` 的 `CERT_TAG` / `ROLE_TAG`；
样式在 `miniprogram/app.wxss`（同时按组件样式隔离要求，在 `components/taskCard/taskCard.wxss` 内保留了一份）。
修改展示规则只需要改这几个地方，页面里不要再各写一套判断。

### 5.9 页面底部「官方 Q 群」提示（在哪里改群号）

小程序 **14 个页面底部**都会显示一行提示：

```
使用中如遇到问题加入官方Q群咨询解决
官方QQ群：123xxxx333
```

**改群号只需要改一处**：`miniprogram/utils/constant.js`

```js
const OFFICIAL_INFO = {
  QQ_GROUP: '123xxxx333',                          // ← 把这里换成你的 QQ 群号
  TIP: '使用中如遇到问题加入官方Q群咨询解决'            // ← 想改提示文案也在这里
};
```

保存后在微信开发者工具重新编译，全部页面底部同步生效。

实现方式：`components/pageFooter/` 组件（各页面 json 已注册 `page-footer`，wxml 底部已写 `<page-footer />`），
新增页面时只要注册并加一个标签即可。

### 5.10 「未送达」反馈（雇主对送达结果不认可）

在「我的发布 → 点击任务详情」中，当跑腿员已提交送达、任务处于 **待雇主确认（status=2）** 时，
详情页会同时显示两个按钮：

- 「确认已送达」：3 秒倒计时后确认，任务变为已完成（status=3），给接单者生成任务收入账单。
- 「未送达」：**本次新增**，点击弹出反馈弹窗。

弹窗规则：

| 操作 | 结果 |
| --- | --- |
| 勾选「不是我的商品 / 商品破损 / 送至错误位置」任意一个或多个 | 直接点「发送」即可提交，无需输入 |
| 勾选「其他」 | 弹窗内展开输入框（聊天窗），必须自行填写问题原因（不少于 2 个字）才能发送 |
| 一个标签都没勾选 | 「发送」不可点击，提示「请至少选择一项原因」 |

**提交后的效果（核心）：**

- `tasks.is_disputed` 被置为 1，写入 `dispute_reason`（标签文案 + 补充说明）与 `dispute_time`。
- 该任务**立刻退出「超过 2 小时自动确认收货」的定时扫描**，不会再被自动判定为已完成，也就不会自动生成任务收入账单。
  必须由雇主手动「确认送达」，或由管理员介入处理。
- 同步生成一条 `report` 举报记录，管理员可在「管理员后台 → 举报处理」中跟进。
- 给跑腿员推送站内消息「雇主反馈未送达」，给雇主推送回执消息。
- 同一任务重复提交返回 409；接口带 3 秒防连点幂等校验。

**列表角标（红色「已申诉」）：**

提交申诉后，以下位置的卡片右上角会多出一个红色「已申诉」角标，并在卡片内显示一行红字说明：

| 页面 | 展示内容 |
| --- | --- |
| 我的发布（Tab） | 角标「已申诉」+ 「已反馈未送达：xxx（系统已停止自动确认收货）」 |
| 我的任务（Tab，跑腿员） | 角标「已申诉」+ 「雇主反馈未正常收到：xxx。系统已停止自动确认收货，请尽快与雇主联系核实。」 |
| 任务卡片组件 `components/taskCard` | 同样展示角标与红字说明（当前仅任务大厅在用，而大厅只展示 status=0 的任务，所以该角标在大厅实际不会出现，属于口径一致性的兜底） |

角标样式类：`.tag-group`（右上角标签组，含状态标签）/ `.tag-danger`（红色角标）/ `.danger`（红色提示文案），
统一维护在 `miniprogram/app.wxss`。是否展示完全由接口下发的 `isDisputed` 决定，前端不做二次推断。

调用链路：`POST /api/task/rejectFinish` → `taskController.rejectFinish` →
`Task.markDisputed`（乐观锁 `WHERE id=? AND status=2 AND is_disputed=0`）+ `Report.create` + `Message.create`（同一事务）。

标签字典在前后端 `utils/constant.js` 中统一维护，禁止硬编码：

```js
const UNDELIVERED_TAG = { 1: '不是我的商品', 2: '商品破损', 3: '送至错误位置', 4: '其他' };
const UNDELIVERED_TAG_OTHER = 4;
```

> 数据库列 `is_disputed / dispute_reason / dispute_time` 由 `src/db/ensureSchema.js` 在服务启动时自动补建，
> 老库无需手工 ALTER。

### 5.11 限时任务倒计时 + 超时送达扣酬金

#### 倒计时（接单后开始，双方都能看到）

限时任务的倒计时从**跑腿员接单那一刻**开始：

```
截止时间 = take_time（接单时间） + time_limit_min（限时分钟数）
```

| 位置 | 展示 |
| --- | --- |
| 任务详情页（雇主 / 接单者都可见） | 「剩余时间 12:34」，橙色加粗；归零后变红色「已超时」 |
| 我的发布（雇主 Tab） | 卡片内「剩余时间」一行，每秒跳动 |
| 我的任务（跑腿员 Tab） | 卡片内「剩余时间」一行，每秒跳动 |

实现要点：

- 倒计时秒数由后端在接口里算好下发（`remainSeconds`），**前端只做本地每秒递减**。
  这样即使手机本地时间与服务端差几分钟，倒计时也不会跳变或错位。
- 列表页离开（`onHide` / `onUnload`）会清理定时器，不会在后台空跑。
- 倒计时归零时列表自动刷新一次——此时后端定时任务可能已按超时自动扣减酬金（任务仍是「进行中(1)」，不会取消）。
- 不限时任务（`time_limit_min = NULL`）不下发 `remainSeconds`，页面不显示倒计时。

#### 限时任务超时：自动扣 5% 酬金（任务不取消，可继续送达）

限时任务接单后开始倒计时，**超过 `time_limit_min` 仍未提交送达**即触发超时规则：

1. 定时任务（每分钟第 0 秒）扫描到该任务，按当前酬金自动扣减 **5%** 作为处罚；
2. 任务**不会被取消**（`status` 保持 1 进行中），跑腿员可以继续送达；
3. 系统**不会自动封禁**跑腿员，是否封禁由管理员决定（见下方「恶意超时投诉与封禁管理」）；
4. 扣减只生效一次（`is_late_reward_deducted = 1`），后续每分钟扫描不会再扣；
5. 若跑腿员此时取消接单，任务回到待接单时会把酬金**原样还原**，不会拿降低后的酬金重新挂到大厅。

扣减规则与雇主在「待雇主确认」阶段手动扣减完全一致：

| 项目 | 规则 |
| --- | --- |
| 扣减比例 | 酬金的 **5%** |
| 保底 | 算出来的金额不足 **0.5 元**时，按 **0.5 元**扣（例如酬金 8 元 → 5% 是 0.4 元 → 实际扣 0.5 元） |
| 上限 | 扣减金额不会超过酬金本身 |
| 次数 | **一次性**，扣完即 `is_late_reward_deducted = 1`，重复调用返回 409 |
| 谁可操作 | 仅任务雇主本人 |
| 生效时机 | 必须在「待雇主确认」阶段、确认送达之前操作 |
| 记账 | 扣减只改 `tasks.reward`，确认送达 / 超 2 小时自动确认时都读这个字段，接单者账单自动按扣减后的金额入账 |

操作路径：「我的发布 → 待雇主确认的任务 → 详情页 → 超时扣减酬金」。点击后弹窗会列出超时时长、扣减金额、扣减后酬金，二次确认后才生效。

相关字段（`src/db/ensureSchema.js` 启动时自动补建，老库无需手工 ALTER）：

| 字段 | 含义 |
| --- | --- |
| `is_late_delivery` | 是否超时送达：0 否 / 1 是 |
| `late_delivery_seconds` | 超出限时的秒数 |
| `is_late_reward_deducted` | 是否已扣减过酬金（保证只扣一次） |
| `late_reward_deduct` | 实际扣减的金额 |

金额计算唯一出口：后端 `src/utils/common.js` 的 `calcLateDeduct(reward)`；
比例与下限写在前后端 `utils/constant.js` 的 `BIZ.LATE_DEDUCT_RATE / BIZ.LATE_DEDUCT_MIN`，要调整只改这两处。

新接口：`POST /api/task/deductLateReward`，入参 `{ taskId }`。

> 说明：超时扣减由定时任务在到点后的一分钟内自动完成，因此绝大多数情况下雇主无需手动点击；
> 详情页的「超时扣减酬金」按钮仅作为兜底（例如跑腿员恰好在扫描间隙提交送达）。

#### 恶意超时投诉与封禁管理

超时处罚只扣钱不封禁，是否封禁由**管理员**决定：

| 环节 | 规则 |
| --- | --- |
| 雇主投诉 | 任务详情页（进行中且已超时 / 超时送达）显示「举报恶意超时」按钮 |
| 投诉落库 | `report.report_type = 2`（恶意超时投诉），管理员后台「举报管理」可按类型筛选 |
| 直达管理员 | 提交后给全部管理员账号（学号命中 `ADMIN_STUDENT_IDS`）推送站内消息，并通知接单人 |
| 防刷 | 同一雇主 + 同一任务只允许 1 条待处理投诉；3 秒内重复提交返回 409 |

封禁管理（管理员后台「封禁管理」Tab）：

| 功能 | 说明 |
| --- | --- |
| 列表 | 只列出**正在封禁中**的用户，一行一排显示账号ID、昵称、学号、手机号、封禁原因、封禁/解禁时间与剩余时长 |
| 搜索 | 顶部搜索框支持 **学号 / 手机号 / 账号ID**（模糊匹配，SQL 全参数化） |
| 封禁 | 可在「举报管理 → 封禁接单人」或「用户管理 → 封禁接单」一键封禁 |
| 加时 | 用户已在封禁中时，在原解禁时间上**继续累加**时长 |
| 解封 | 立即清空 `ban_take_time`，并推送站内消息；重复解封返回 409 |
| 时长档位 | 5分钟 / 15分钟 / 30分钟 / 1小时 / 2小时 / 1天 / 自定义 |
| 自定义 | 年 / 月 / 日 / 时 / 分 / 秒，**每项最小为 0，不填即表示该项为 0**（全空或合计为 0 会被拒绝） |
| 到期 | 定时任务每分钟自动解禁到期用户 |
| 红线 | 管理员账号不可被封禁（后端按学号白名单硬校验，返回 403） |

相关接口（均需管理员权限，路由层 `auth + adminAuth` 双重校验）：

| 接口 | 说明 |
| --- | --- |
| `POST /api/task/reportLateTaker` | 雇主举报接单人恶意超时（`{ taskId, reason? }`） |
| `GET /api/admin/userList` | 用户列表（`page` / `pageSize` / `keyword`），手机号完整显示 |
| `POST /api/admin/updateUser` | 修改用户资料（`{ userId, nickname?, name?, phone?, studentId?, isCampusAudit?, avatar? }`） |
| `POST /api/admin/resetUserPassword` | 重置登录密码（`{ userId, newPassword? }`，留空则自动生成随机密码并返回） |
| `GET /api/admin/banList` | 封禁列表（`page` / `pageSize` / `keyword`） |
| `POST /api/admin/banUser` | 封禁 / 加时（`{ userId 或 keyword, durationType, custom, reason }`） |
| `POST /api/admin/unbanUser` | 解封（`{ userId }`） |
| `GET /api/admin/searchTask` | 订单管理：搜索订单（`page` / `pageSize` / `keyword`），返回任务完整详情与双方资料 |
| `POST /api/admin/updateTask` | 订单管理：编辑订单（`{ taskId, receiverName?, receiverPhone?, pickupCode?, deliverAddress?, detailAddress?, timeLimitMin?, remark?, reward?, img1~img3? }`） |
| `POST /api/admin/deleteTask` | 订单管理：删除订单（软删除，`{ taskId, reason? }`；待接单订单自动返还 1 张发布券） |

新增字段（`src/db/ensureSchema.js` 启动时自动补建）：`users.ban_reason / ban_operator_id / ban_created_at`、`report.report_type`。
---
### 5.12 新版账号体系（已去掉短信验证码，零成本）

> 短信验证码按条计费、个人开发者又难通过模板审核，因此整套账号体系改为
> **「图形验证码 + 自选账号ID + 密保问题 + 设备保护」**，全部在本地服务端完成，**不产生任何费用**。

| 环节 | 现在的做法 | 说明 |
| --- | --- | --- |
| 注册 | 填账号ID（`X` 前缀，可随机生成）+ 密码 + 图形验证码 + 勾选协议 | 手机号**选填**、不发验证码，仅用于人工联系；姓名 / 学号留到校园认证阶段填 |
| 密码强度 | 8~20 位且必须同时包含字母和数字 | 弱密码（纯数字/纯字母/太短）直接 400 拒绝 |
| 图形验证码 | 服务端本地生成的算术题 PNG（5 分钟有效、一次一用） | 零成本人机校验，替代短信；答案只存服务端，日志里能看到（便于自动化测试） |
| 密保问题 | 注册后**必须先设 2 道密保**才能用小程序 | 答案 bcrypt 哈希入库；未设置时其它业务接口统一返回 `428` |
| 忘记密码 | 已认证账号：账号ID + 学号 + 姓名 + 2 道密保答案；未认证账号：账号ID + 2 道密保 | 全部答对才放行，任何一项不符统一提示「账号信息校验失败」（防止探测账号是否存在） |
| 重置限制 | 同一账号 24 小时只能重置 1 次；密保连续答错 5 次锁定 15 分钟 | 重置成功后清空设备标识，所有旧设备立即失效并收到站内消息 |
| 换设备保护 | 已绑定过的设备 / 微信 openid 直接放行；新设备必须答对 2 道密保才下发令牌 | 微信 `code2Session` 免费；未配置 AppSecret 时自动退回设备指纹方案 |
| 设备管理 | 「我的 - 登录设备」可查看已绑定设备并解绑非本机 | 单账号最多 5 台设备 |
| 登录锁定 | 连续密码错误 5 次锁定账号 15 分钟，与密保锁定相互独立 | 锁定期内无论密码对不对都返回锁定提示，且按 user_id 统计、切换登录方式也无法绕过 |

**接口限流（都在 `backend/.env` 可调）**

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CAPTCHA_HOURLY_LIMIT` | 60 | 同一 IP 1 小时最多获取图形验证码次数 |
| `ACCOUNT_HELPER_HOURLY_LIMIT` | 120 | 同一 IP 1 小时最多调用「随机账号ID / 校验账号ID」次数 |
| `REGISTER_IP_HOURLY_LIMIT` | 100 | 同一 IP 1 小时最多注册次数（另有「同一账号ID 1 小时 5 次」的账号级限流） |
| `SECURITY_HOURLY_LIMIT` | 60 | 同一 IP 1 小时最多调用密保相关接口次数 |

> 为什么这些值比以前大？因为**校园网 / cpolar 内网穿透下所有用户可能共用一个出口 IP**，
> 阈值太紧会把整栋楼的同学一起限流；真正防刷的是「图形验证码 + 单账号锁定 + 幂等校验」这三层。

**账号体系相关回归脚本**

```powershell
cd <项目根目录>\backend
node scripts\regression-account-security.js   # 26 项：注册 / 密保 / 换设备解锁 / 密保找回密码
node scripts\regression-admin-login.js        # 26 项：管理员与登录通道 + 管理员订单管理（搜索/编辑/删除/越权）
node scripts\regression-business-flow.js      # 102 项：业务全流程（含账号体系相关校验）
node scripts\regression-take-race.js         # 20 项：并发接单（5 人同抢一个任务）
```

> 这些脚本通过读取后端日志里的图形验证码答案来完成自动化（等价于人工看图输入），
> 因此**不能把当前正在写入的后端日志清空**。日志现在按天分文件，脚本会自动定位
> `backend\logs\server-*.out.log` 里最近修改的那一个（也可用环境变量 `BACKEND_LOG` 指定）；
> 脚本运行前建议先重启一次后端，让内存里的限流计数归零。

### 5.13 管理员订单管理（搜索 / 处罚 / 编辑 / 删除）

管理员后台顶部的**「订单管理」**Tab（`pages/admin/admin.wxml`，`tab === 'order'`）用于处置具体订单：

1. **搜索订单**：支持 `订单号（GCPT+数字，可只输片段）`、`任务ID（输入 12 或 #12）`、
   `雇主 / 接单人的 账号ID / 学号 / 手机号 / 昵称`、`收件人手机号`、`送达地址`；
   不输关键词则按 id 倒序展示全部订单（**含已被删除的订单**，卡片上标注「已被管理员删除」与删除原因）。
2. **查看详情**：卡片直接展示订单号、状态、限时倒计时（进行中限时任务显示「剩余 mm:ss」，
   超时显示红色「已超时」）、雇主 / 接单人 mini 卡片（点击可查看并修改该用户全部资料）、
   双方手机号（管理员不脱敏）、收件人、取件码、送达地址、详细地址、酬金、服务费、
   支付状态、时间轴、任务图片与送达照片预览；点「查看详情」跳转任务详情页。
3. **处罚**：卡片上的「处罚雇主 / 处罚接单人」直接复用 `POST /api/admin/banUser` 的封禁弹窗
   （5 分钟 / 15 分钟 / 30 分钟 / 1 小时 / 2 小时 / 1 天 / 自定义年月日时分秒）；
   管理员账号不会被列入可处罚对象（后端按学号白名单硬校验）。
4. **编辑订单**：白名单字段（收件人姓名 / 手机号 / 取件码 / 送达地址 / 详细地址 / 限时 / 备注 /
   酬金 / 任务图片），事务 + `SELECT ... FOR UPDATE` + 乐观锁 `WHERE id=? AND is_deleted=0`；
   **管理员不受「酬金仅可提高」「两次编辑间隔 3 分钟」「status=0 才可编辑」限制**；
   `status / is_deleted / once_taken / is_refunded` 等流转与资金字段无法被改写（白名单锁定）；
   保存后自动向雇主（酬金变动时还包括接单人）推送站内消息；
   若修正的是**已完成**订单的酬金，同步更正该订单的「任务收入」账单金额，避免对账不一致。
5. **删除订单**：走 `POST /api/admin/deleteTask` 软删除（数据保留作为处置留痕），
   可从「删除原因（选填，最多 200 字）」输入框填写原因，删除后任务从任务大厅 / 我的发布 /
   我的任务全部下架；**待接单订单的服务费自动原路退回**，用免费代拿权益发布的待接单订单自动返还次数。

> 幂等：编辑与删除都带 `checkIdempotent` 防连点（同一管理员 3 秒内提交相同请求返回 409）；
> 越权：普通用户调用 `/api/admin/searchTask` / `/api/admin/updateTask` 一律 403（回归脚本已覆盖）。

### 5.14 顶号提示 + 设备登录地点（同一账号在两台手机上登录）

**背景**：单设备登录下，新设备登录会把旧设备「静默顶下线」。旧设备原本只是莫名掉线，
既无法自证，也发现不了账号被盗用。

**现在的行为**（`backend/src/controllers/userController.js` 的 `finishLogin`）：

1. 每次登录/注册/密保解锁成功都会记录本次的 **IP 与归属地**（写进 `user_device.login_ip / login_region`）；
2. 若本次登录设备与账号当前登录设备不同（顶号），会为**被顶下线的旧设备**写一条
   `user_kick` 记录（新设备名称 / 时间 / IP / 归属地），同时给账号本人推一条站内消息留痕；
3. 旧设备下一次请求（任意业务接口）会被 `middleware/auth.js` 拦下，返回
   `401 + data.kicked = true`，并带上结构化提示字段；
4. 小程序 `utils/request.js` 的 `showKickNotice()` 收到后先清理登录态，再弹窗告知：

   > 您的账号在另一台设备「华为 Mate60」于 2026-09-19 16:20 登录
   > （登录地点：某省-某市，IP：1.2.3.4），当前设备已被强制下线。
   > 若非本人操作，请立即联系管理员，并及时修改密保设置与登录密码。

   点「知道了」后回到登录页。提示只弹一次，不会反复打扰。
5. `app.js` 的 `onShow` 会在每次回到小程序前台时主动探测一次登录态，因此用户无需手动操作就能尽快看到提示。

**关于「未知」的三个坑（已全部修掉，别再踩）**：

1. **注册 / 登录漏传 IP** — `finishLogin` 早期只传了 `deviceId`，没传 `ip`，
   导致 `user_device.login_ip` 永远是空串，提示里只能显示「未知 IP」。
   现在注册（`userController.js` 的注册分支）与登录都补上了 `ip: getClientIp(req)`。
2. **记录被提前消费** — 前端收到 401 后会先自动刷新令牌（`utils/request.js` 的 `refreshToken()`），
   这一跳同样会走进顶号分支并把 `user_kick` 标记已读；等真正弹窗时记录已读、内容只剩「未知」。
   现在 `auth.js` 与 `refreshToken` 分支都**不再**标记已读，改为 `let kickData = null`，
   `buildKickNotice(kick)` 返回 null 时给 `fail()` 传 `undefined`；
   记录的生命周期改为「该设备下次成功登录时」由 `User.clearDeviceKicks()` 统一清掉。
3. **空对象兜底渲染** — `buildKickNotice` 现在先判断 `if (!row.id) return null;`，
   前端 `showKickNotice()` 也在 `hasDetail` 为假时直接 `redirectToLogin()`，不弹半截空弹窗。

另外：`normalizeIpForDisplay()` 会剥掉 `::ffff:` 前缀；`resolveRegionLabel()` 对
内网 / 回环地址返回字典项 `MSG.KICK_NOTICE_LOCAL_REGION`（「局域网」），公网解析失败才显示「未知地点」。

**设备登录地点**：「我的 → 设备管理」（`pages/devices/devices.wxml`）每台设备都展示
`登录地点：某省-某市（IP 1.2.3.4）`，取不到归属地时退化为只显示 IP。

- 归属地解析在 `backend/src/utils/ipRegion.js`：主通道 `ip-api.com`，备用通道 `whois.pconline.com.cn`，
  24 小时正缓存 + 10 分钟负缓存 + 1.5 秒超时，**解析失败绝不影响登录**（只显示 IP）；
- 内网 / 回环地址（`127.0.0.1`、`192.168.x.x`）直接跳过解析，不消耗外部请求；
- 设备名通过请求头 `X-Device-Name` 传输，中文名会先 `encodeURIComponent`（HTTP 头只允许 ASCII），
  后端 `getDeviceName()` 自动还原；
- 相关字段全部走 `backend/src/utils/constant.js` 的 `MSG.KICK_*` 文案字典，
  `miniprogram/utils/constant.js` 保持完全一致，前端不硬编码中文。

- **编码处理（易踩坑）**：备用通道 `whois.pconline.com.cn` 返回的是 **GBK** 字节流，早期版本统一按
  UTF-8 解码，汉字会被替换成 `U+FFFD`（`�`）写进库，于是「我的设备」里登录地点显示成一串乱码方块。
  现在 `ipRegion.js` 按「Content-Type 的 charset -> 严格 UTF-8 -> GB18030 兜底」解码，
  并在 `normalizeArea()` 里拦掉含 `U+FFFD` 的结果（宁可显示未知地点，也绝不写乱码）；
  历史脏数据用 `node scripts/fixRegionGarbled.js --dry-run` 先看，再 `node scripts/fixRegionGarbled.js` 按 IP 重新解析修回。

**回归验证**：`node scripts/regression-kick-device.js`（21 项断言，含顶号提示内容、
**重复请求仍返回完整提示（记录未被提前消费）**、登录 IP 确实落库、设备列表 IP / 归属地字段、
已删除任务的布尔 `actions` 全 false）。清理任务 `jobCleanKickRecords` 每天 04:00 归档。

> 注意：`actions.takeDisabledReason` 是**文案字段不是布尔开关**，断言时要单独排除，
> 只对布尔键断言全 false。

### 5.15 全站 UI 设计系统（v6 · iOS / Apple HIG）

全站视觉的唯一依据是 `docs/design-system.md`，令牌定义在 `miniprogram/app.wxss` 的
`page` 选择器上。v6 在 v5「切换到 Apple HIG」的基础上，把「照搬 iOS 系统色」
升级成**一套自洽的品牌色板**：

1. **主色换成信任蓝 `#2b5ce6`**：白底文字 5.5:1、蓝底白字 5.5:1，**文字与按钮双向都过 WCAG AA**。
   v5 的 `#007aff` 作文字只有 3.0:1，必须另配一个更深的 `#0062cc` 才能用；v6 统一成一个值，
   `--brand` 与 `--brand-deep` 同色，页面里不用再纠结该取哪一个。
2. **新增辅助色暖橙 `#ee6c2d`**（金额文字档 `#c2410c`，5.2:1）：只用于「金额 / 紧迫 / 权益」，
   与主色形成冷暖分工；金额一律走 `--money`，修掉了「金额用危险红」这类语义串台。
3. **语义色收敛成一套三档色板**：文字档按 AA 校准（绿 `#0a7a54` / 橙 `#b45309` / 红 `#c81e1e`），
   填充档（`#0e9f6e` / `#d97706` / `#e02424`）只做纯装饰色块，淡底（`--*-soft`）只做徽标背景。
4. **中性色改冷灰阶**：底 `#f5f7fa` → 分隔 `#e6eaf2`（实体冷灰，不再是半透明黑）→
   描边 `#d5dbe6` → 文字四级 `#0f172a / #475569 / #6b7688 / #9aa5b4`
   （对比度 18.1 / 7.5 / 4.5 / 2.5:1）。
5. **圆角与字号收紧成两套固定阶梯**：圆角 8 / 16 / 28 / 32 / pill，
   字号 22 / 24 / 28 / 30 / 34 / 44 / 52（rpx）。本次把页面里散落的
   18、20、22、26、29、32、38、40、48、56rpx **全部归位到令牌**，并补了 `--scrim` 遮罩令牌；
   除 `border-radius: 50%` 与图标内部的 2~8rpx 微调外，样式里不再有裸写数值。
6. **动效沿用 Apple 推荐曲线与时长**：按压 120ms（pointer-down 即刻反馈）、
   状态切换 220ms、弹窗 320ms、大位移 400ms；缓动
   `cubic-bezier(0.23,1,0.32,1)` / `(0.77,0,0.175,1)` / `(0.32,0.72,0,1)`，
   **不使用 `ease-in`**（起步慢＝感觉卡）；只动 `transform` / `opacity`，保证 60fps。
7. **无障碍**：`@media (prefers-reduced-motion: reduce)` 降级 —— 系统开启「减弱动态效果」时
   用交叉淡入替代位移与弹性；对比度 ≥4.5:1 与触摸目标 88rpx（≈44pt）同为硬约束。
8. **图标全部用 CSS 绘制**：`app.wxss` 第 6 节提供 `.ico-search / .ico-ban / .ico-trash /
   .ico-lock / .ico-edit / .ico-minus / .ico-info` 等，颜色跟随 `currentColor`。
   **管理后台里原先当图标用的 emoji 已全部替换** —— emoji 在不同机型上字形、大小、
   颜色都不一致，且无法跟随主题色，属于明确的 UI 反模式。
9. **标题用 Large Title**：登录 / 首页顶部为白底大字 + 负字距，不再铺彩色渐变；
   首页搜索栏改成「灰色圆角搜索框 + 右侧蓝色文字操作」的系统搜索栏形态。
10. **公共样式抽取**：`miniprogram/styles/auth.wxss`（登录/注册/忘记密码三页共用）、
    `miniprogram/styles/list.wxss`（我的发布 / 我的任务共用），避免同一套样式复制两份。
11. **tabBar 配色**：常态 `#6b7688` / 选中 `#2b5ce6`，与 `miniprogram/app.json` 的
    `tabBar.color` / `tabBar.selectedColor` 完全一致；改配色后必须重跑
    `python tools\make_tab_icons.py` 重新生成 8 张 PNG。

改完 UI 后务必执行 `node backend\scripts\checkMiniProgram.js`：
它会校验 JS/JSON/WXML/WXSS 语法、标签闭合、花括号平衡，以及
**`<text>` 内容不能另起一行**（微信会把该换行渲染成空行，把标签背景框撑大）。

## 六、cpolar 内网穿透（真机 + 微信回调调试）

> 用途：让公网（手机真机预览、支付回调 / 虚拟支付发货推送）能访问本机 `http://localhost:3000`。

### 6.1 检查是否已安装

```powershell
cpolar version
```

已安装则跳到 6.3。

### 6.2 安装

1. 打开官网下载 Windows 版：<https://www.cpolar.com/download>
2. 解压到固定目录，例如 `D:\cpolar\`，得到 `cpolar.exe`
3. 注册 cpolar 账号 -> 后台「验证」页面复制 **authtoken**

```powershell
# 把 cpolar 加入 PATH（管理员 PowerShell 执行一次，按实际解压目录调整）
$old = [Environment]::GetEnvironmentVariable('Path','Machine')
[Environment]::SetEnvironmentVariable('Path', $old + ';D:\cpolar', 'Machine')
# 重开终端后验证
cpolar version
```

### 6.3 配置 authtoken

```powershell
cd D:\cpolar
.\cpolar authtoken 你的authtoken
```

### 6.4 启动隧道（映射本机 3000 端口）

```powershell
cd D:\cpolar
.\cpolar http 3000
```

终端会输出形如：

```
Forwarding   https://1a2b3c4d.r3.cpolar.cn -> http://localhost:3000
Forwarding   http://1a2b3c4d.r3.cpolar.cn  -> http://localhost:3000
```

- 外网访问后端健康检查：`https://1a2b3c4d.r3.cpolar.cn/api/health`
- 上传图片可直接访问：`https://1a2b3c4d.r3.cpolar.cn/uploads/202609/xxx.jpg`

固定二级域名（付费版支持，免费版每次重启会变化）：

```powershell
.\cpolar http -subdomain=campus-errand 3000
```

### 6.5 让小程序走 cpolar 域名

```javascript
// 开发者工具 Console 执行一次即可（写入本地缓存）
wx.setStorageSync('BASE_URL', 'https://1a2b3c4d.r3.cpolar.cn')
// 恢复本机直连
wx.setStorageSync('BASE_URL', 'http://localhost:3000')
```

### 6.6 微信支付回调地址

```env
# backend/.env
WX_NOTIFY_URL=https://1a2b3c4d.r3.cpolar.cn/api/pay/notify
```

### 6.7 注意事项

- cpolar 免费版域名**不能**在小程序后台配置为「request 合法域名」，只适合打开「不校验合法域名」做开发调试。
- 正式上线必须使用**已 ICP 备案**的自有域名 + HTTPS。
- cpolar 进程需保持运行，否则外网访问立即中断。
- 若本地用 `PAY_MODE=simulate`（默认），则完全不需要公网回调，第六节可整体跳过。

---

## 七、迁移到 Linux 云服务器

以 Ubuntu 22.04 / 24.04 + Nginx + PM2 为例（阿里云 / 腾讯云均可）。

### 7.1 服务器初始化

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx

# 时区务必设为上海，否则定时任务与「24 小时退券」判定会错位
sudo timedatectl set-timezone Asia/Shanghai
date
```

### 7.2 安装 Node.js（>= 18）

```bash
# 检查
node -v

# 未安装则用 NodeSource 安装 Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

### 7.3 安装 MySQL 8.0

```bash
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
sudo systemctl status mysql

# 安全初始化（设置 root 密码、移除匿名用户）
sudo mysql_secure_installation
```

### 7.4 建库并导入 9 张表

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS campus_errand DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
mysql -u root -p campus_errand < /var/www/campus-errand/backend/sql/init.sql
mysql -u root -p -e "USE campus_errand; SHOW TABLES;"
```

建议创建独立数据库账号（不要用 root 跑业务）：

```sql
CREATE USER 'campus'@'localhost' IDENTIFIED BY '强密码';
GRANT ALL PRIVILEGES ON campus_errand.* TO 'campus'@'localhost';
FLUSH PRIVILEGES;
```

### 7.5 上传代码

```bash
sudo mkdir -p /var/www/campus-errand
sudo chown -R $USER:$USER /var/www/campus-errand

# 本地 Windows 执行（Git Bash / PowerShell 均可）
scp -r <项目根目录>\backend  root@服务器IP:/var/www/campus-errand/
# 或使用 git 拉取
```

### 7.6 配置生产 .env

```bash
cd /var/www/campus-errand/backend
cp .env.example .env
vim .env
```

生产环境必改项：

```env
NODE_ENV=production
PORT=3000
DB_USER=campus
DB_PASSWORD=强密码
JWT_SECRET=用 openssl rand -hex 32 生成的随机串
ADMIN_STUDENT_IDS=真实管理员学号
# 个人主体：virtual（虚拟支付 + 发布券）；企业商户号：api_v3；绝对不能留 simulate
PAY_MODE=virtual
# 虚拟支付三项（PAY_MODE=virtual 时必填，未填会直接报错）
XPAY_OFFER_ID=虚拟支付商户号OfferID
XPAY_APP_KEY=现网AppKey
XPAY_COUPON_PRODUCT_ID=publish_coupon
XPAY_COUPON_PRICE_FEN=10
# 订阅消息（留空则不下发，站内信照常保留）
WX_SUBSCRIBE_ORDER_TEMPLATE=模板ID
WX_SUBSCRIBE_STATE=formal
# 内容安全：上线必须开启
SEC_CHECK_ENABLE=true
SEC_CHECK_FAIL_MODE=closed
# 数据库每日备份
BACKUP_ENABLED=true
BACKUP_DIR=/var/backups/campus_errand
BACKUP_KEEP_DAYS=14
SMS_MOCK=false
WX_APPID=正式AppID
WX_APP_SECRET=正式AppSecret
# 下面这组只有 PAY_MODE=api_v3（企业商户号）才需要
WX_MCH_ID=商户号
WX_API_V3_KEY=APIv3密钥
WX_MCH_SERIAL_NO=商户证书序列号
WX_CERT_PATH=./cert/apiclient_cert.pem
WX_KEY_PATH=./cert/apiclient_key.pem
WX_PLATFORM_CERT_PATH=./cert/wechatpay_platform_cert.pem
WX_NOTIFY_URL=https://你的域名/api/pay/notify
```

```bash
mkdir -p cert uploads
chmod 600 cert/*.pem
npm install --omit=dev
```

### 7.7 用 PM2 常驻运行

```bash
sudo npm install -g pm2

cd /var/www/campus-errand/backend
pm2 start src/app.js --name campus-errand
pm2 logs campus-errand          # 查看日志
pm2 save                        # 保存进程列表
pm2 startup                     # 生成开机自启命令，按提示复制执行一次
```

常用命令：

```bash
pm2 restart campus-errand       # 重启
pm2 stop campus-errand          # 停止
pm2 monit                       # 实时监控
```

### 7.8 Nginx 反向代理

```bash
sudo vim /etc/nginx/sites-available/campus-errand
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 3m;          # 上传图片 2MB，留出余量

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/campus-errand /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 7.9 HTTPS（必须，微信小程序强制）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
sudo systemctl status certbot.timer
```

### 7.10 安全组 / 防火墙

- 云控制台安全组放行 **80 / 443**，**不要**对公网开放 3306 与 3000。
- 服务器本地防火墙：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### 7.11 小程序侧收尾

1. 微信公众平台 -> **开发 -> 开发管理 -> 服务器域名**：
   - request 合法域名：`https://your-domain.com`
   - uploadFile 合法域名：`https://your-domain.com`
   - downloadFile 合法域名：`https://your-domain.com`
2. 微信支付商户平台配置回调/授权域名。
3. `miniprogram/utils/request.js` 的 `BASE_URL` 改为 `https://your-domain.com`，或在 Console 执行 `wx.setStorageSync('BASE_URL', 'https://your-domain.com')`。
4. 开发者工具「详情 -> 本地设置」取消勾选「不校验合法域名」做一次回归，确认线上域名可用。

### 7.12 数据备份（已内置，无需再配 cron）

后端已内置**每日 05:00 自动全量备份**（`src/schedule/index.js -> jobBackupDb`，实现见 `src/utils/dbBackup.js`）：

```bash
# backend/.env
BACKUP_ENABLED=true
BACKUP_DIR=/var/backups/campus_errand   # Linux；Windows 例：D:\backup\campus_errand
BACKUP_KEEP_DAYS=14                      # 超期自动清理（只删 campus_errand_ 前缀的 .sql）
MYSQLDUMP_PATH=                          # 留空自动探测（PATH -> Windows/Linux 常见安装位置）
```

```bash
# 手动备份一次（上线前、改表结构前强烈建议执行）
cd backend && node scripts/backupDb.js
# 只看现有备份列表
cd backend && node scripts/backupDb.js --list
# 恢复（备份文件自带 CREATE DATABASE / USE，可直接整库还原）
mysql -u root -p < /var/backups/campus_errand/campus_errand_20260920_140539.sql
```

> 实现细节：密码通过 `MYSQL_PWD` 环境变量传入，不出现在命令行（避免被 `ps` 看到）；先写 `.tmp` 再改名，中途失败不会留下半个备份；0 字节一律视为失败并删除。

---

## 八、业务规则速查

### 8.1 状态字典（前后端完全一致，禁止硬编码文案）

| 字典 | 取值 |
| --- | --- |
| `is_avatar_audit` | 0 无申请 / 1 待审核 / 2 审核通过 / 3 已驳回 |
| `is_campus_audit` | 0 无申请 / 1 待审核 / 2 审核通过 / 3 已驳回 |
| `tasks.status` | 0 待接单 / 1 进行中 / 2 待雇主确认 / 3 已完成 / 4 超时取消 / 5 雇主主动撤销 |
| `audit_apply.status` | 1 待审核 / 2 审核通过 / 3 已驳回 |
| `appeals.status` | 1 待处理 / 2 已回复 |
| `report.status` | 1 待处理 / 2 已处理完毕 |
| `messages.msg_type` | 1 系统消息 / 2 管理员消息 / 3 任务消息 / 4 雇主消息 |
| `payments.status` | 0 待支付 / 1 支付成功 / 2 支付失败 / 3 已退款 |
| `user_bill.type` | 1 任务收入 / 2 服务费支出 |
| `ROLE_TAG`（账号角色标识） | 0 普通用户 / 1 管理员（白名单账号自动校园认证并展示该标识） |
| 接口错误码 | 200 成功 / 400 参数错误 / 401 登录已失效 / 403 无权限 / 409 操作冲突 / 423 账号已锁定 / 500 服务器内部错误 |

### 8.2 关键阈值

| 规则 | 阈值 | 位置 |
| --- | --- | --- |
| 信息服务费 | 0.10 元 | `SERVICE_FEE` |
| access / refresh 有效期 | 2 小时 / 7 天 | `JWT_ACCESS_EXPIRES` / `JWT_REFRESH_EXPIRES` |
| 连续密码错误锁定 | 5 次锁 15 分钟 | `LOGIN_FAIL_LIMIT` / `LOGIN_LOCK_MINUTES` |
| 超时扣酬金比例 | 酬金的 5%（不足 0.5 元按 0.5 元） | `LATE_DEDUCT_RATE` / `LATE_DEDUCT_MIN` |
| 封禁时长档位 | 5分钟 / 15分钟 / 30分钟 / 1小时 / 2小时 / 1天 / 自定义 | `BAN_DURATION`（前端展示），实际时长由后端 `adminController.normalizeDuration` 计算 |
| 接单后可取消 | 10 分钟 | `CANCEL_TAKE_MIN` |
| 两次编辑/加酬金间隔 | 3 分钟 | `EDIT_INTERVAL_MIN` |
| 退券窗口 | 任务已由雇主撤销（status=5）且发布 < 24 小时且 `once_taken=0` | `REFUND_LIMIT_HOURS` |
| 自动确认 | 待确认 > 2 小时 | `AUTO_CONFIRM_HOURS` |
| 校园认证提交 | 7 天 3 次 | `CAMPUS_APPLY_LIMIT` / `CAMPUS_APPLY_DAYS` |
| 管理员账号 | 白名单学号自动校园认证 + 管理员标识，无需提交申请 | `ADMIN_STUDENT_IDS` |
| 申诉 | 每人每天 2 条 | `APPEAL_DAILY_LIMIT` |
| 短信验证码 | 6 位、5 分钟、一次有效；60 秒 1 条、1 小时 5 条 | `SMS_*` |
| 物品照片 | 提交完成时必传，至少 1 张、最多 3 张（接单人拿到 / 买到物品的凭证） | `MAX_DELIVERY_IMG` |
| 送达照片 | 至少 1 张、最多 3 张 | `MAX_DELIVERY_IMG` |
| 单张图片 | 2MB，仅 jpg/png/webp，校验文件头 | `UPLOAD_MAX_SIZE` |
| 确认送达倒计时 | 3 秒 | `PENDING_CONFIRM_COUNTDOWN` |
| 限时任务倒计时 | 接单时间 + `time_limit_min`，双方列表与详情页实时展示 | `computeRemainSeconds` |
| 超时送达扣酬金 | 酬金 5%，不足 0.5 元按 0.5 元，一次性 | `LATE_DEDUCT_RATE` / `LATE_DEDUCT_MIN` |

### 8.3 酬金规则

- 待接单任务编辑：酬金**可提高或保持不变**，禁止降低。
- 进行中任务：仅可单独调整酬金，且必须**严格大于**原酬金；调整成功后站内消息通知接单者。
- `status >= 2` 的任务：所有字段一律不可编辑。

### 8.4 退券流程（两步操作，撤销不会自动返还）

> 【B 方案变更】微信**个人主体虚拟支付不支持退款**，因此「退费」整体改为「**退券**」：
> 撤销任务返还 1 张「发布券」（价值 0.1 元），下次发布任务时自动抵扣信息服务费。
> 与退款相比用户没有损失，平台也不用垫资。券余额存在 `users.publish_coupon_count`。

退券拆成**两步**，撤销本身**不会**自动返还：

1. **撤销任务**：任务详情页「撤销任务」，或「我的发布」卡片上的「撤销」。
   任务立即置为 `status=5`（雇主主动撤销）、从任务大厅下架、不可再次编辑，此时**不返还**。
2. **申请退券**：「我的发布」→ 状态筛选「雇主主动撤销」→ 任务卡片上的「申请退券」。
   满足条件时返还 1 张发布券：`payments.status=3`（已退款）、`tasks.is_refunded=1`、`users.publish_coupon_count + 1`，任务仍保持 `status=5`。

退券条件（三项同时满足）：任务已由雇主撤销 + 从未被接单（`once_taken=0`）+ 发布未超过 24 小时。
不满足时卡片上会直接显示原因（后端 `actions.refundDisabledReason` 下发，前端不硬编码规则）。

**发布任务的费用来源**（`tasks.pay_channel`，决定撤销时退什么）：

| `pay_channel` | 含义 | 实付 | 撤销时 |
| --- | --- | --- | --- |
| `0` | 邀请码免费代拿权益 | 0 元 | 返还权益次数（不返券） |
| `1` | 现金支付（模拟支付 / 虚拟支付） | 0.1 元 | 返还 1 张发布券 |
| `2` | 发布券抵扣 | 0 元 | 返还 1 张发布券 |

> 抵扣优先级与后端 `createOrder` 完全一致：**免费代拿权益 > 发布券 > 现金支付**。
> 为什么两步：旧实现允许「待接单」任务直接退款，会出现「钱已退、任务还挂在大厅」的脏状态；
> 现在 `applyRefund` 只接受 `status=5` 的任务，从接口层面也堵死了这条路径。

### 8.5 账号与登录规则

- **账号编号（account_no）**：管理员 `A0001`，普通用户注册时按 `X0001`、`X0002` … 递增发号；
  编号由后端生成并加唯一索引，并发注册冲突时自动取下一个序号重试。
- **多方式登录**：账号编号（`A0001` / `x0001`，大小写不限）、11 位手机号、纯数字主键 id（去前导零）
  三条通道最终都定位到同一个 `user_id`，权限、锁定、单设备规则完全一致。
- **防暴力破解**：连续密码错误 5 次锁定 15 分钟，锁定期内密码正确也返回锁定提示；
  错误计数按 `user_id` 统计，切换登录方式无法绕过；登录成功自动清零解锁。
- **单设备登录**：新设备登录写入新的 `login_device_id`，旧设备 token 立即失效。

> 查看用户数据的入口见 [5.7 账号编号规则与「在哪里查看用户数据」](#57-账号编号规则与在哪里查看用户数据)。

---

## 九、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `端口 3000 已被占用` | 已有实例在跑：`Get-NetTCPConnection -LocalPort 3000 -State Listen` 找到 PID 后结束进程，再启动 |
| 启动报数据库连接失败 | 检查 MySQL80 服务是否运行、`.env` 的账号密码与库名、库是否已建 |
| `npm install` 时 bcrypt 编译失败 | 属正常降级场景（bcryptjs 已内置），可忽略；或安装 VS Build Tools 后重装 |
| 小程序请求失败 / 域名不合法 | 开发者工具勾选「不校验合法域名」；正式环境需备案域名 + HTTPS 并配置到后台 |
| 手机真机连不上本机后端 | 换内网 IP、放行 3000 端口防火墙、确认在同一 WiFi |
| 定时任务不触发 | 检查服务是否常驻（PM2 / nohup）、服务器时区是否为 `Asia/Shanghai` |
| 退券提示超过 24 小时 | `publish_time` 与当前服务器时间之差判定，先校准服务器时间 |
| 提交完成提示「请先上传物品照片 / 送达照片」 | 业务强校验：物品照片 + 送达照片各至少 1 张（各最多 3 张），前端按钮在未选图时置灰 |
| 管理员后台进不去 | 当前登录账号学号不在 `ADMIN_STUDENT_IDS` 白名单内（改 `.env` 后需重启服务） |
| 管理员账号显示「未认证」 | 学号不在白名单，或改了 `.env` 没重启服务。重启后看启动日志是否有「管理员账号同步完成」 |
| 管理员标识别人看不到 | 前端未同步更新（`miniprogram/utils/constant.js` 需与后端一致），改完需重新编译 / 重新上传体验版 |
| 管理员无法接单/发布 | 重启后端让白名单同步生效；管理员账号会自动 `is_campus_audit=2`，无需提交校园认证 |
| 账号被锁 15 分钟 | 连续 5 次密码错误触发，可等锁定到期（定时任务自动解锁）或改数据库 `login_lock_time` |
| 选完照片 / 拍完照后没反应、图片不显示 | 旧版本上传失败会静默跳过，已修复：超 2MB 自动压缩，真机上传失败会自动降级 base64 通道并弹出明确提示 |
| 手机真机请求正常但上传图片失败 | 只配了 request 合法域名，还需配置 **uploadFile 合法域名**（配置后重启开发者工具 / 重新上传体验版） |
| 首页任务大厅一直「暂无任务」 | 已修复：前端未填酬金时传的是空串，后端 `parseMoney('')` 得到 0，SQL 变成「酬金 0~0」把任务全部筛掉了；现在空值一律不参与筛选 |
| 首页排序按钮点了没反应 | 同上，列表被筛空时排序看不出效果；修复后时间/酬金排序与酬金区间筛选均生效 |
| 撤销任务后没收到返还 | 【B 方案】撤销只下架任务，需到「我的发布」→ 筛选「雇主主动撤销」→ 点「申请退券」才返还 1 张发布券（虚拟支付不支持退款，详见 §8.4） |
| 已撤销任务没有「申请退券」按钮 | 仅「从未被接单 + 发布未超过 24 小时 + 未退券」可退券，卡片上会显示具体原因 |
| 上传的图片访问 404 | 确认文件在 `backend/uploads/` 下，且通过 `/uploads/相对路径` 访问 |

---

## 十、验证结论（本次交付自检结果）

| 脚本 | 结果 |
| --- | --- |
| `node scripts/checkAll.js` | 全部自检通过（42 个模块加载 + 7 项核心函数断言） |
| ~~`node scripts/smokeTest.js`~~ | **已停用**：基于旧「手机号 + 短信验证码」账号体系，接口已下线。改用 `regression-business-flow.js` |
| `node scripts/scheduleTest.js` | **44 项断言全部通过**（超时自动扣 5% 酬金 / 任务不取消不封禁 / 恶意超时投诉直达管理员 / 封禁生效与到期解禁 / 申诉任务跳过自动确认 + 幂等） |
| ~~`node scripts/apiCoverageTest.js`~~ | **已停用**：同上（旧短信账号体系）。接口覆盖改由 `regression-business-flow.js` + `regression-account-security.js` 承担 |
| `node scripts/checkMiniProgram.js` | 小程序 30 个 JS / 27 个 JSON / 23 个 WXML / 26 个 WXSS 全部通过（失败 0 个） |
| `node scripts/checkMiniProgramBindings.js` | **全部通过**：23 个页面四件套齐全、23 个 WXML 的事件方法全部存在、数据字段 0 缺失、`@import` 0 失效、class 0 未定义 |
| `node scripts/checkPageRuntime.js` | 20 个页面定义全部加载成功（失败 0 个） |
| `node scripts/checkPageLifecycle.js` | 23 个页面/组件生命周期实跑无异常（失败 0 个） |
| `node scripts/checkPageIntegration.js` | **全功能联调通过**：20 个页面在「真实后端 + 真实登录态 + 真实业务数据」下全部正常渲染，21 次请求 0 异常；跑完自动清理测试账号 |
| `node scripts/checkAdminStatus.js` | **17 项断言全部通过**（数据库自动认证 / 登录返回管理员身份 / 任务列表下发管理员标识） |
| `node scripts/regression-admin-login.js` | **26 项断言全部通过**（管理员登录三通道 / 订单管理搜索·编辑·处罚·删除 / 已删除订单检索与冻结） |
| `node scripts/regression-account-security.js` | **36 项断言全部通过**（图形验证码 / 自选账号ID / 密保设置与自定义题目 / 换设备解锁 / 密保找回密码），跑完自动清理测试账号 |
| `node scripts/regression-kick-device.js` | **21 项断言全部通过**（顶号提示内容 / 重复请求仍返回完整提示 / 登录 IP 落库 / 设备登录 IP 与归属地 / 已删除任务接单入口冻结与下架文案） |
| `node scripts/regression-message-badge.js` | **28 项断言全部通过**（消息详情归属校验 / 打开即已读且幂等 / 清除未读只影响本人 / tabBadge 只统计未完成任务） |
| `node scripts/regression-take-race.js` | **20 项断言全部通过**（5 人同一瞬间抢同一个任务：恰好 1 人成功、其余 4 人 409「任务已被他人接单」；落库只有一个接单人；雇主只收到 1 条接单消息；失败方详情页 canTake=false 且看到真正接单人；连点与事后重试均被拒），跑完自动清理测试账号 |
| UI 设计系统 v6（iOS / Apple HIG） | 主色信任蓝 `#2B5CE6`（文字/按钮双向 AA 5.5:1）+ 辅助色暖橙 `#EE6C2D`（只用于金额/紧迫/权益）+ 语义色三档（文字档 AA `#0A7A54`/`#B45309`/`#C81E1E`、填充档仅装饰、淡底仅徽标）+ 冷灰阶（底 `#F5F7FA` / 分隔 `#E6EAF2` / 描边 `#D5DBE6`）+ 圆角与字号两套固定阶梯（8/16/28/32/pill、22/24/28/30/34/44/52rpx）+ Apple 动效曲线（120/220/320/400ms，禁用 ease-in）+ `prefers-reduced-motion` 降级 + tabBar 图标 `#6B7688`→`#2B5CE6`，规范见 `docs/design-system.md` |

---

## 十一、上线检查清单（提审前逐项确认）

> 结论：**代码与功能侧已达到可上线水平**（全量自检 0 失败、包体 1191 KB、未申请任何多余权限、上传与越权防护有回归断言守护）；
> 但**配置与外部账号侧还有 7 项必须替换**，不换则提审会被驳回，或上线后不可用 / 不安全。

### 11.1 现状总览

| 检查项 | 当前状态 | 结论 |
| --- | --- | --- |
| 后端接口域名 | `https://你的域名`（内网穿透临时域名） | **必须换**，审核机请求不通会以「功能不可用」驳回 |
| 公众平台合法域名 | 未配置 | **必须配**，request / uploadFile / downloadFile 三类都要加 |
| 支付 | `PAY_MODE=simulate`（点支付即成功） | **必须改**：个人主体走 `virtual`（虚拟支付 + 发布券），企业商户号走 `api_v3`，否则用户付不了钱 |
| 短信 | `SMS_MOCK=true`，但短信通道已整体下线 | 不阻塞：注册 / 登录 / 找回全部走「图形验证码 + 密保」，`SMS_*` 仅历史占位配置 |
| 小程序服务类目 | 未选择 | **必须选**，提审硬性要求（跑腿 / 校园服务类目） |
| 隐私保护指引 | 代码内已内置协议文本，公众平台未填报 | **必须填**，微信强制，不填直接驳回 |
| `DB_PASSWORD` / `DB_USER` | 本机 `root` + 弱口令 | **必须改**，上云后数据库密码等于公开 |
| `ADMIN_STUDENT_IDS` | 占位学号（上线前必须替换成本校真实学号） | **必须改**，否则管理员身份错误 |
| `JWT_SECRET` | 已是 64 位随机串 | 通过（迁移服务器时不要沿用旧串） |
| 内容安全（UGC 文本） | 代码已接入，`SEC_CHECK_ENABLE=false` | 建议开启（见 11.3） |
| 图片内容安全 | 未接入（需公网回调 + 微信消息推送） | 建议按类目要求评估 |
| 小程序包体 | 1191 KB（单包上限 2 MB） | 通过 |
| 权限申请 | `app.json` 无 `permission` 字段，代码无 `wx.getLocation` 等调用 | 通过（不会因「申请无关权限」被驳回） |
| sitemap | 已 `disallow pages/admin/admin`，其余 allow | 通过 |
| 上传安全 | 路径穿越 5 类攻击全部 403、图片地址带时效签名、越权访问被拒 | 通过 |
| 全量自检 | 见第十章，全部 0 失败 | 通过 |

### 11.2 必做七步

1. **域名与 HTTPS**：域名完成备案 + 配置 HTTPS 证书（微信只认 443 端口，不支持 IP 与自签证书）。
   公众平台 → 开发管理 → 服务器域名，把域名**同时**加入 request / uploadFile / downloadFile 三类合法域名。
2. **改前端地址**：`miniprogram/utils/request.js` 第 20 行的 `BASE_URL` 换成正式域名，改完重新上传体验版。
3. **改支付回调**：`backend/.env` 的 `WX_NOTIFY_URL` 同步改成正式域名下的 `/api/pay/notify`。
4. **接支付**：个人主体走虚拟支付 —— 开通虚拟支付后填 `XPAY_OFFER_ID` / `XPAY_APP_KEY` / `XPAY_COUPON_PRODUCT_ID`，并把 `PAY_MODE` 改成 `virtual`（详见 §12.3）；已开通企业商户号则改 `PAY_MODE=api_v3` 并填 `WX_MCH_ID`、`WX_MCH_SERIAL_NO`、`WX_API_V3_KEY`，商户证书放进 `backend/cert/`。
5. **接短信**：`SMS_MOCK=false`，填阿里云四项参数（AK / SK / 签名 / 模板 CODE）。
5. **换密钥与口令**：`JWT_SECRET` 用 48 字节以上的随机 hex；`DB_PASSWORD` 换强密码；`DB_USER` 不要用 root，单独建一个只对本库有权限的账号。
6. **配管理员**：`ADMIN_STUDENT_IDS` 填真实管理员学号（改完重启服务，启动日志会打印「管理员账号同步完成」）。
7. **公众平台填报**：服务类目（跑腿 / 校园服务）；用户隐私保护指引如实勾选手机号、学号、姓名、身份证截图（校园认证）、相册（上传照片）、设备信息。
   前端协议文本在 `miniprogram/utils/agreement.js`，两边口径必须一致；如新增收集项，需同步改这里并在公众平台补录。

### 11.3 建议开启（不阻塞提审，但线上更稳）

- **内容安全**：`SEC_CHECK_ENABLE=true` + `SEC_CHECK_FAIL_MODE=closed`（微信侧异常时拦截而不是放行）。
  已覆盖任务备注、用户昵称两个 UGC 入口；开启前确认 `WX_APPID` / `WX_APP_SECRET` 已是正式小程序的值。
- **图片内容安全**：当前只校验了上传类型 / 大小 / 访问签名，未做违规图片识别。
  若类目要求，需要接 `mediaCheckAsync` 异步检测 + 微信消息推送（要求公网可回调的 HTTPS 地址）。
- **部署方式**：`npm install --omit=dev` 只装生产依赖；用 PM2 常驻：`pm2 start src/app.js --name campus-errand`，
  并 `pm2 save` + `pm2 startup` 保证开机自启（Windows 本地的 `auto-restart-backend.ps1` 只是本地守护方案）。
- **目录权限**：`backend/uploads/` 与 `backend/cert/` 仅服务账号可读写；`cert/` 绝不能放在任何静态资源目录下。
- **备份**：数据库每日 `mysqldump`，`uploads/` 目录与数据库备份异地各存一份（图片丢了无法从库里恢复）。
- **服务器时间**：确保时区为 `Asia/Shanghai`，否则超时扣款、退券 24 小时窗口、定时任务全部错位。

### 11.4 代码侧已达标项（本次交付已处理，无需再改）

- 包体：1191 KB < 2 MB；`images/campus-cert-guide.png`（584 KB）已替换为 154 KB 的 JPEG。
- 控制台：唯一一处 `console.log`（`miniprogram/utils/request.js` 上传选图日志）已按开发 / 体验版门控，正式版不输出。
- 权限：删除未使用的 `permission.scope.userLocation`，避免「申请与功能无关的权限」被驳回。
- 索引：`sitemap.json` 已屏蔽 `pages/admin/admin`，防止管理员页被微信收录。
- 可观测性：`app.js` 已加 `onError` / `onUnhandledRejection` / `onPageNotFound` 兜底，异常写入本地 `appErrorLog`（只存时间 / 类型 / 路由 / 摘要，不含隐私）。
- 提审自检：`utils/request.js` 内置上线自检，检测到 localhost / 内网 / cpolar / ngrok 等临时地址会在控制台醒目提示替换三步。
- 安全回归：上传路径穿越、签名过期与篡改、越权访问（普通用户查他人资料 / 订单、非管理员进后台）均有断言守护，见第十章。

---

## 十二、上线新增能力（内容合规 / 图片压缩 / 虚拟支付 / 订阅消息 / 备份 / 依赖）

本轮为「个人主体 + 虚拟支付」上线路线补齐的六件事，全部已落地并通过回归。

### 12.1 内容合规：UGC 文本检测已开启

`SEC_CHECK_ENABLE=true` + `SEC_CHECK_FAIL_MODE=closed`（微信侧异常时宁可让用户稍后重试，也不放过违规文本）。

覆盖的 UGC 入口（新增入口时必须同步补上，清单也在 `src/utils/wxSecCheck.js` 头部）：

| 入口 | 检测字段 |
| --- | --- |
| 发布 / 编辑任务 | 收件人姓名、送达地址、详细地址、帮带物品、取件码、任务备注（6 个字段拼成 1 次请求，不额外增加等待） |
| 头像 / 昵称 / 校园认证审核 | 昵称 |
| 举报 | 举报原因、补充说明（`reportController` / `reportTaker` / `reportLateTaker` / `rejectFinish`） |
| 申诉 | 申诉正文 |
| 管理员公告 | 公告正文（公告会推送给全部用户，误发代价更大，因此同样过检） |

> 实现要点：微信内容安全 **v2 接口必须带本小程序用户的真实 openid**，否则返回 `40003`。
> openid 从 `user_device` 表取（带 5 分钟内存缓存），取不到时自动退回 v1 接口（v1 不需要 openid），管理员账号也能正常过检。
> 图片内容安全（`mediaCheckAsync`）需要稳定的公网 HTTPS 回调地址，本项目**暂未接入**，提审前请确认是否必须。

### 12.2 图片压缩：上传前无条件重压

`miniprogram/utils/image.js` 提供 `compressForUpload()`，**每次上传都压**（不再只在超过 2MB 时才压）：

- 长边压到 `1280px`，JPEG 质量 `0.75`；压完仍超限则用质量 `0.45` 再压一次；
- 三级降级链：离屏 canvas 重绘导出 JPG → `wx.compressImage` → 原图直传，任一环节失败都不会卡住上传；
- PNG 透明区域先铺白底，避免转 JPEG 后变黑。

实测：`3000×2000` 的图 → `1280×853`、约 **12 KB**。

### 12.3 虚拟支付：发布券（个人主体 B 方案）

`PAY_MODE=virtual` 时，发布任务的 0.1 元信息服务费走微信小程序**虚拟支付**（道具直购），只卖一种道具：**发布券**。

- 服务端：`src/utils/virtualPay.js`（`paySig` = HMAC-SHA256(AppKey, `requestVirtualPayment&signData`)、`signature` = HMAC-SHA256(sessionKey, signData)）；
- 顺序：`createOrder` 返回 `payParams` → 前端 `wx.requestVirtualPayment` → 微信推「道具发货」XML 到 `POST /api/pay/xpayNotify` → 后端发货并返回 `<ErrCode>0</ErrCode>`；
- 幂等：以 `outTradeNo` 定位流水，`markPaymentSuccess` 的条件更新保证重复推送只发货一次；
- 兜底：`virtualPay.queryOrder()` 可主动查单补发货（发货推送丢失时使用）。

开通步骤：小程序后台 → 功能 → 虚拟支付（需要**服务类目含「工具」**且已完成认证备案）→ 拿到 `OfferID` / `现网 AppKey` → 在虚拟支付后台创建「发布券」道具 → 把四项写进 `.env` → `PAY_MODE=virtual`。

> ⚠️ 发货推送需要**稳定的公网 HTTPS 回调地址**。当前用 cpolar 时隧道重建地址会变，上线前必须换成已备案域名，否则会漏发货。

### 12.4 订阅消息：任务进度通知

用户在**发布任务 / 接单 / 确认取货**时弹窗征求一次授权，后端在 4 个进度点下发：

| 进度 | 发给谁 | `phrase2` |
| --- | --- | --- |
| 被接单 | 发布者 | 已接单 |
| 已取货 | 发布者 | 已取货 |
| 已送达（含超时送达） | 发布者 | 已送达 |
| 已完成 | 接单者 | 已完成 |

- 后端：`src/utils/wxSubscribe.js`（`sendOrderProgress`），**永远不抛异常**，失败只写日志；
- 前端：`miniprogram/utils/subscribe.js` 的 `requestOrderSubscribe()`，用户拒绝也照常走完业务流程；
- 降级：模板未配置 / 用户未授权（`43101`）/ 微信侧异常 → 站内信始终是保底通道；
- 模板 ID 必须两边一致：`.env` 的 `WX_SUBSCRIBE_ORDER_TEMPLATE` ↔ `miniprogram/utils/subscribe.js` 的 `ORDER_TEMPLATE_ID`。

### 12.5 数据库备份

见 §7.12：每日 05:00 自动全量备份 + `node scripts/backupDb.js` 手动备份。

### 12.6 依赖版本（已升级并通过全量回归）

| 依赖 | 升级前 | 升级后 |
| --- | --- | --- |
| `express` | ^4.19.2 | ^4.21.2 |
| `mysql2` | ^3.11.0 | ^3.14.4 |
| `multer` | ^1.4.5-lts.1 | ^2.0.2 |
| `dotenv` | ^16.4.5 | ^16.6.1 |
| `jsonwebtoken` | ^9.0.2 | ^9.0.3 |

> `bcryptjs` / `node-schedule` 保持不变（无安全公告且行为稳定，避免无谓风险）。

### 12.7 回归命令

```bash
cd backend
node scripts/checkAll.js                     # 模块加载 + 纯函数断言
node scripts/regression-business-flow.js     # 业务全流程 123 项
node scripts/regression-coupon-pay.js        # 发布券 / 退券 32 项（本轮新增）
node scripts/regression-account-security.js  # 账号体系 36 项
node scripts/regression-admin-login.js       # 管理员 26 项
node scripts/regression-media-security.js    # 图片签名 28 项
node scripts/regression-message-badge.js     # 消息角标 32 项
node scripts/regression-kick-device.js       # 顶号提示 22 项
node scripts/regression-garbage-cleaner.js   # 垃圾清理 39 项
node scripts/regression-take-race.js         # 抢单并发 20 项
node scripts/scheduleTest.js                 # 定时任务 47 项
```

### 12.8 上线前数据清洁（cleanForLaunch.js）

把测试期间造出来的账号、任务、订单、消息、举报、公告一次性清掉，只留管理员账号：

```powershell
cd <项目根目录>\backend
node scripts\backupDb.js                  # 1) 先备份（强烈建议）
node scripts\cleanForLaunch.js --dry-run  # 2) 先看清要删多少条（不落库）
node scripts\cleanForLaunch.js            # 3) 真正执行
```

| 对象 | 处理 |
| --- | --- |
| `tasks` / `payments` / `user_bill` / `messages` / `report` / `appeals` / `audit_apply` / `announcements` / `sms_code` / `user_kick` | 全部清空并重置自增（上线后第一单从 1 开始编号） |
| `users` | 只保留学号 `你的管理员学号` 的管理员，其余账号连带外键数据一起删除；保留账号头像 / 校园认证图指向的文件已不存在时自动置空（否则前端裂图 + 垃圾清理任务一直看到悬空引用） |
| `user_device` | 只保留管理员的真实设备，自动化脚本用过的假 `device_id`（`admin-dev` / `helper-admin-device` 等）一并删除 |
| `uploads/` 测试图片、历史日志 | 脚本不碰文件，需要时手动清（见下方命令） |

```powershell
# 清空测试图片（保留目录结构，上线后用户上传会重新写入）
Get-ChildItem <项目根目录>\backend\uploads -Recurse -File | Remove-Item -Force
```

> - 想保留的管理员学号不是 `你的管理员学号`：改 `.env` 的 `KEEP_ADMIN_STUDENT_ID` 再执行；
> - 找不到该管理员账号时脚本会**主动中止**，不会误删全部用户；
> - 备份文件默认落在 `D:\backup\campus_errand\`（见 §7.12），恢复命令脚本执行完会打印；
> - ⚠️ 两个回归脚本依赖「库里已有被引用的图片」：`regression-media-security.js`（取 `uploads/202609/` 第一张图当样本）、`regression-garbage-cleaner.js`（抽查数据库引用的图片是否还在），在**全空库**上会各报 1~2 项「失败」，属于缺样本环境问题、不是代码缺陷；想跑满分请先留一张图 + 一条引用即可。
