# weekly-report — 每周邮件周报

每周固定时刻（默认**周日 00:00**，也就是「周六夜里零点」）把这一周的 **token 用量**和**工作汇总**
发到你指定的邮箱。数据直接来自 DSH 自己写的会话日志，不给每个数字估「大概」——只有**价格**是配置里填的。

- 收件人：`lzx_xkzdwb@163.com`（`config.to`）
- 发件账号：`xkdobepc@163.com`（`config.address`，授权码复用 `email-approval/secrets.json`）
- 触发时刻：**每周日 00:00（Asia/Shanghai）** = 周六晚上 24:00
- DSH 正好没开？下次启动**补发一次**，主题里标「（补发）」

> 「周六晚上凌晨 0 点」按「周六 24:00 = 周日 00:00」实现，所以 `weekday: 0`。
> 如果你其实想要**周六 00:00**（周五夜里零点），把 `weekday` 改成 `6` 即可，其余不用动。

## 邮件里有什么

```
主题：[DSH 周报] 2026-10-29 ~ 2026-11-05 · 2.12 亿 tokens / ¥149.81
```

| 区块 | 内容 |
|---|---|
| 一句话 | 本周会话数、模型调用次数、总 token、预估费用，以及和上周的对比 |
| Token 用量 | 总量 / 输入 / 输出 / 缓存读 / 缓存写、调用次数、会话数（主会话与子代理分开）、用户发言数、工具调用数 |
| 每天 | 7 行日期，缺的那天补 0，纯文本用方块、HTML 用横条 |
| 按模型 | 每个 `provider/model` 的调用次数、token、费用、费用占比 |
| 工作汇总 | 按**项目（会话的工作目录）**分组，每个项目下列出这周动过的会话：标题、日期、token、费用，外加**首条请求**摘要（默认 140 字） |
| 工具调用 | 这周用得最多的 5 个工具 |

HTML 版只放内联样式、没有任何外部图片/字体/脚本，163、手机客户端、Outlook 都能正常显示；
纯文本版同内容，按等宽对齐，`cat` 出来也能看。

没有模型调用的一周也会发：正文写「这一周没有任何模型调用记录」，主题写「本周无记录」——
这样你能区分「没发」和「这周真没干活」。

## 装上它

1. 把下面这段加进 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `- insert:` 列表
   （文件里已经有 `tool-deepseek-web`、`approval-email`，加在同一层）：

```yaml
    - id: weekly-report
      name: "P:/工程/DeepseekHarness/系统/weekly-report/src/plugin.js"
      config:
        to: lzx_xkzdwb@163.com
        address: xkdobepc@163.com
        displayName: DSH 周报
        secretsFile: "P:/工程/DeepseekHarness/系统/email-approval/secrets.json"
        weekday: 0          # 0=周日 … 6=周六
        time: "00:00"       # 必须带引号，不然 YAML 会当成 60 进制整数
        timeZone: Asia/Shanghai
        catchUp: true
        windowDays: 7
```

完整版（含价格表注释）见 `examples/cordis.patch.snippet.yml`。

2. **重启 DSH**。插件是在 HOST 启动时按路径装载的：改 yml 时 HOST 会自动重载配置，
   但如果改的是**插件源码**（`src/*.mjs`），已加载的模块不会重新 import——必须重启一次才会用上新代码。

3. 重启后确认它真的装上了（下面两条只读路由由插件自己注册）：

```powershell
curl http://127.0.0.1:1869/plugin-weekly-report/status
curl "http://127.0.0.1:1869/plugin-weekly-report/preview?days=7&format=html" -o preview.html
```

- `/status` 返回：`schedule`（每周几几点）、`nextRunLocal`（下次发送）、`lastSentAt`、`sends`、`lastError`、`dryRun`。
- `/preview` 用**现在**的数据渲染一封完整周报，**不发信**；`format=html` 直接在浏览器里看排版，
  `format=text` 看纯文本版，默认 json（只有主题和汇总数字）。预览有 30 秒缓存。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `to` | —（必填） | 收件人，必须是完整邮箱 |
| `address` | `xkdobepc@163.com` | 发信账号 |
| `displayName` | `DSH 周报` | 发件人显示名 |
| `secretsFile` | 空 | 放 `{"authCode":"…"}` 的 JSON；也可以直接写 `authCode` |
| `smtp` | `smtp.163.com:465`（SSL） | 换邮箱时改这里，支持 `starttls` |
| `weekday` | `0` | 0=周日 … 6=周六（JS `getDay` 口径） |
| `time` | `"00:00"` | 当地 24 小时制，必须 `HH:MM` |
| `timeZone` | `Asia/Shanghai` | 定时与邮件里的日期都按它算；写错会直接报错 |
| `catchUp` | `true` | 到点时 DSH 没开，下次启动补发一次 |
| `windowDays` | `7` | 邮件覆盖发送时刻往前多少天 |
| `tickIntervalMs` | `60000` | 多久检查一次是否到点 |
| `topProjects` | `6` | 工作汇总最多列几个项目（按花费降序） |
| `sessionsPerProject` | `6` | 每个项目最多列几个会话（按最后活动时间） |
| `topTools` | `5` | 工具 Top N |
| `promptChars` | `140` | 每个会话引用首条请求的字数上限 |
| `currency` / `pricing` | `CNY` / 见下 | 与 04-统计插件同一套占位价，单位是**每 100 万 token** |
| `stateFile` / `auditFile` | 插件目录 | 状态与审计落盘位置 |
| `dryRun` | `false` | 到点只记账不发信，用来先观察一周 |

价格默认值（和用量统计面板一致，所以两边费用对得上）：

```yaml
pricing:
  default: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }
  models:
    xh-v1api/deepseek-v4.1-flash: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 1 }
```

## 数据怎么来的

```
ctx.sessionQuery.listSessions()  → 全部会话（跨工作区）
ctx.sessionQuery.readSession(id) → 每个会话的完整事件日志
  ├─ assistant/message + data.usage → inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
  ├─ assistant/message.data.message.source → provider / model（费用分档）
  ├─ user/message(source.kind='user') → 人类发言、首条请求摘要
  ├─ tool/call → 工具名
  └─ session/title → 会话标题
```

几个口径：

1. **按事件时间过滤，不是按会话**。上周开的会话这周还在用，只算落在窗口内的那些 `assistant/message`；
   窗口是左闭右开 `[from, to)`，正好落在发送时刻的那条不算。
2. **四类 token 分开计价**：`total = input + output + cacheRead + cacheWrite`，各乘各的单价。
   拿 total 乘一个单价会算贵一大截（缓存读通常便宜得多）。
3. **费用不落盘**，每次用当前价格表重算，改价格立刻生效。
4. **子代理会话算进总量**，但在「会话数」里单列，不混进主会话。
5. **工作汇总的分组键是会话的工作目录**（`header.cwd`），不是项目名——重名目录不会串。
6. 邮件里只有计数、标题和请求摘要，**不含任何消息正文或工具输出**；摘要与标题里疑似密钥的内容
   （`sk-…`、`ghp_…`、JWT、32 位以上十六进制、`password: …` / `token=…` 之类）会被替换成
   `[已隐去密钥]` / `[已隐去令牌]` / `[已隐去]`，避免把粘过的 key 带进邮箱。

## 补发、重试、记账

- `state.json`：`installedAt`、`lastSentAt`、`lastPeriodEnd`、`sends`、`lastError`。原子写（临时文件 + rename）。
- 启动时算「上一次发送时刻」：
  - 从没发过（刚装）→ 只排下一次，**不会**立刻发一封。
  - 装过、但错过了至少一个发送时刻 → 立刻补发最近那一期，主题带「（补发）」。
  - `catchUp: false` → 错过就跳过，等下个周期。
- 发送失败（SMTP 5xx、断网）：10 分钟后重试，最多 5 次；仍失败就跳过本轮、写 `lastError`，下周照常。
- `audit/sent.jsonl`：每封一行 JSON（时间、周期、主题、会话数、token、费用、收件人、messageId、耗时、是否补发、是否 dry-run）。
- 邮件底部会写「下次发送：…」，和 `/status` 里的 `nextRunLocal` 一致。

## 命令行（不启动 DSH 也能跑）

```powershell
# 用真实日志渲染一份周报，打印纯文本（不发信）
node tools/weekly-report.mjs

# 顺便把 HTML 存下来，用浏览器看排版
node tools/weekly-report.mjs --html preview.html

# 真的发一封测试信（主题前缀区分）
node tools/weekly-report.mjs --send --subject-prefix "[DSH 周报测试]"

# 按「配置里的发送时刻」取上一个完整周期，而不是「此刻往前 7 天」
node tools/weekly-report.mjs --end schedule

# 只握手认证、不发信
node tools/probe-mail.mjs

# 看会话日志的事件结构（排查「为什么这周数字不对」）
node tools/probe-session.mjs
```

`node` 用 DSH 自带的那个：
`D:\Program Files\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。

命令行这条路径走 `src/source-fs.mjs`，直接读 `~/.dsh/sessions/*/*/session.v4.jsonl.zstd`，
和 HOST 里走 `sessionQuery` 的折法逐条对齐（同一份 `collect.mjs` / `report.mjs`）。

## 测试

```powershell
node test/run-tests.mjs
```

32 条用例，不联网、不发信：定时（含跨时区、正好到点、周六/周日之争）、配置校验、窗口左闭右开、
四类 token 计价、按天补齐、项目分组与截断、密钥打码、HTML 转义、空周兜底、运行器的
「第一次不发」「到点只发一次」「错过补发」「关掉补发」「dry-run 记账」「失败重试」，
以及用假 `ctx` 跑一遍 `apply()`：两条路由挂得上、`/status` 报得出下次发送、`/preview` 三种格式都能渲染。

## 验证记录（2026-11-05）

| 检查 | 结果 |
|---|---|
| 16 个 js/mjs `node --check` | 全过 |
| `node test/run-tests.mjs` | 32/32 通过（含假 ctx 的 `apply()` 装配与两条路由） |
| 真实日志跑命令行 | 42 个会话、读取 478ms；一周 41 会话 / 1,443 次调用 / 2.12 亿 tokens / ¥149.81 |
| 与用量面板对比 | 同一窗口、同一价格表，费用一致（面板 7 天 ¥148.12 是更早时刻取的） |
| 装进 profile 后 | `cordis.patch.yml` 一改，HOST 自动重载：`GET /plugin-weekly-report/status` 200，`nextRunLocal` = `2026-11-08 00:00` |
| 线上 preview | `format=text` 200（42 会话 / 1,533 次 / 2.22 亿 tokens / ¥155.33），`format=html` 200（19 KB） |
| SMTP 认证探测 | `smtp.163.com:465` TLS 92ms，`AUTH` 235，`NOOP` 250 |
| 真实发信 | 已发出一封 `[DSH 周报测试]`，163 返回 250 接收，messageId 记在控制台 |
| 密钥打码 | 实跑预览里，某会话请求中粘贴过的 `sk-…` 已渲染成 `[已隐去密钥]` |
| HTML 结构 | 标签配平（div 86/86、table 3/3、tr 14/14、td 51/51、th 9/9），无 `undefined`/`NaN` |

**没能验证的**：邮件在 163 网页端/手机端的**最终视觉效果**——这台机器的沙箱不让起浏览器进程，
截不了图。请自己打开 `preview.html` 或刚收到的那封测试信扫一眼，重点看浅色背景上的对比度和表格宽度。

## 已知边界

- **只按计划发**：DSH 没运行就不发，只能下次启动补发；关机一周以上也只补最近一期。
- **会话标题是 DSH 自动生成的**（`session/title`），可能是英文（请求是英文时），也可能落成「fallback」截断题；
  邮件只是照搬，不做二次润色。
- **「工作汇总」是清单，不是读后感**：给的是项目 → 会话 → 首条请求，不做语义摘要，也不猜你改了什么文件。
- **跨周会话按事件切分**：上周开的会话这周继续用，两边各算各的事件，所以「会话数」和面板的「会话数」口径不完全一样
  （面板按会话整体归档，本插件按窗口内是否有活动）。
- **价格是配置里的占位值**；走中转/不同模型的实际单价请自己改 `pricing`，否则费用只是相对量。
- **时区只影响定时与日期分桶**；小时级分桶按当地日期做，不做小时曲线。
- `state.json` 与 `audit/` 在插件目录里；删掉 `state.json` 等于「重新装一次」（不会立刻补发）。

## 文件

| 文件 | 作用 |
|---|---|
| `src/plugin.js` | 插件入口：注册定时器、两条只读路由；配置错只记日志、不拖垮启动 |
| `src/config.mjs` | 配置归一化与校验（时间、时区、价格、邮件地址） |
| `src/schedule.mjs` | 时区安全的「每周某天 HH:MM」下次/上次计算 |
| `src/collect.mjs` | 折会话日志：窗口过滤、四类 token、按天/按模型/按项目 |
| `src/report.mjs` | 渲染纯文本 + HTML 正文、主题 |
| `src/runner.mjs` | 定时状态机：补发、重试、dry-run、记账 |
| `src/state.mjs` | `state.json` 原子读写 |
| `src/source-fs.mjs` | 离线数据源：直接读 zstd 会话日志（命令行/测试用） |
| `src/mail/{socket,mime,mail-smtp}.mjs` | 零依赖 SMTP/MIME，拷自 `email-approval`（逐字节相同，可独立运行） |
| `src/mail/send.mjs` | 把配置 + 正文交给 SMTP |
| `tools/weekly-report.mjs` | 命令行预览 / 测试发送 |
| `tools/probe-mail.mjs` | SMTP 握手认证探测（不发信） |
| `tools/probe-session.mjs` | 会话日志事件结构探查 |
| `tools/check-html.mjs` | 邮件 HTML 标签配平自查 |
| `test/run-tests.mjs` | 29 条离线用例 |
| `examples/cordis.patch.snippet.yml` | 装配片段 |
| `preview.html` | 最近一次渲染出的 HTML 预览（可直接用浏览器打开） |
