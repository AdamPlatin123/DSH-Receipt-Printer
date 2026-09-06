# DSH Receipt Printer

> **Agent 工作小票** — 把每个 DSH agent session 的关键统计 + LLM 自动任务回执打成一张 58mm 物理热敏小票。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blueviolet)](https://github.com/deepseek-ai/deepseek-harness)
[![Tests](https://img.shields.io/badge/tests-45%2F45-brightgreen)](test/e2e.mjs)

```
DSH RECEIPT
2026-09-06 01:13        host dsh-tui
项目        DSH-Receipt-Printer
时长                  00:23:45
轮次                          3
模型         deepseek-v4-flash
工具调用 (35)
Edit   ■■■■■■■■■■            17
Bash   ■■■■■■□□□□            12
产出文件 (4)
+ collector.ts  + bridge.ts
TOKEN
  input     251.8K
  output     80.2K
  cacheR      7.3M
COST [峰]             Y0.3781
  余额              Y1145.15
RECAP                    ← LLM 自动生成
完成: 修复 recap 换行截断
产出: thermal_bridge.py
下一步: 真机验证
[QR: session-id]
```

## 安装

```sh
# 前置: Node ≥ 22.15 (DSH zstd 依赖, 推荐 24)、pnpm ≥ 10、Python 3.10+
#       一台已配好 Win32 打印队列的 58mm ESC/POS 热敏打印机
dsh plugin add "github:AdamPlatin123/DSH-Receipt-Printer"
# 或本地 checkout
dsh plugin add "file:/abs/path/to/DSH-Receipt-Printer"
# 重启 dsh-tui / dsh-desktop, 对话一轮 → turn 结束自动吐小票
```

同一份插件在 **dsh-tui**（TTY）和 **dsh-desktop**（Electron）中无需修改即可工作 —— 它只订阅 DSH 核心 `session/event` seam，不依赖任何 host 专属服务。

---

## 工作原理

```
DSH Host (dsh-tui 或 dsh-desktop, 同一 Cordis 运行时)
        │
        ├── session/event (turn/start | tool/call | assistant/message | turn/end)
        ▼
src/collector.ts        ReceiptCollector 累积 per-session stats
        │ turn/end 触发 (trigger: turn-end | session-end | manual)
        ▼
src/recap.ts            自动 LLM 任务回执 (tool-less 单轮, ~100 字中文)
src/pricing.ts          峰谷感知 CNY 计费 (官方 2026-08 价目表)
src/balance.ts          GET /user/balance 实时余额 (5 分钟缓存)
        ▼
src/bridge.ts           spawn(pythonCmd, [vendor/thermal_bridge.py])
        │ stats JSON → stdin (UTF-8)
        ▼
vendor/thermal_bridge.py  stats JSON → ESC/POS 字节 (58mm / GBK / ■□)
        ▼
Win32 spooler raw print → 58mm thermal printer → 🧾
```

**核心 seam 选择**：只用 `session/event` / `session/disposed` 这两个 DSH **核心 seam**。`commands` 服务软探测（`ctx.get('commands', false)` 风格），缺了不阻塞启动。

## DSH 真实事件契约

DSH 事件结构是 `{type, seq, time, data}` 四字段包装，**payload 在 `.data`**，字段 camelCase：

| event.type | data 字段 | 用法 |
|---|---|---|
| `turn/start` | `{turn}` | 计数 +1 |
| `turn/end` | `{turn, reason}` | **触发打印** |
| `tool/call` | `{turn, step, callId, name, arguments: JSON-string}` | `data.name` 计数 / parse `arguments` 取 `file_path` |
| `assistant/message` | `{turn, step, message, usage?: TokenUsage}` | `usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` |

## 自动 Recap（任务结束 → 一张完善小票）

turn/session 结束时 plugin **主动调 `llm.stream()`** 让 LLM 用自然中文总结任务（做了什么 / 产出了什么 / 下一步），与统计**合并为同一张小票**：

- `provider`/`model` 从 `session.requestHeader()` 取（与 dsh-tui `/btw` 同源）
- `reasoningEffort: 'off'` —— reasoning 模型会烧 30s+ 才出文本
- `source.plugin = 'dsh-receipt-printer'`（不含 btw/recap，避免被自己的 wrap 拦截）
- **降级链**：LLM 不可用 / 超时 / 流空 → 自动退回纯统计小票

**踩坑记录**（都已修）：
1. `content` 必须是 `[{type:'text', text}]` block 数组（裸 string 立即 `finish{error}`）
2. 必须 `provider`+`model`（缺 provider → `no adapter registered for provider "undefined"`）
3. 必须 `reasoningEffort: 'off'`（不关 reasoning → 3411 个 reasoning-delta 烧满超时）

## Token 计费（CNY 口径，对齐 dsh-tui 方案）

价目表 = DeepSeek 官方「模型 & 价格」页 2026-08 快照（元 / 1M tokens）：

| 模型 | input·miss | input·hit | output |
|---|---|---|---|
| **V4-Flash** | 谷 1.5 / 峰 3.0 | 谷 0.05 / 峰 0.10 | 谷 4.5 / 峰 9.0 |
| **V4-Pro** | 谷 4.5 / 峰 9.0 | 谷 0.15 / 峰 0.30 | 谷 13.5 / 峰 27.0 |
| **V4-Flash-Vision-Exp** | 同 Flash | 同 Flash | 同 Flash |

- **峰谷窗口**：北京时间**周一至周五** 9:00-12:00、14:00-18:00（周末永远谷价）
- **公式**：`(input − cacheRead) × miss + cacheRead × hit + output × out`，cacheWrite 不单独计费（已含在 input miss 侧）
- **模型匹配**：前缀最长优先（vision-exp 等自动归类）
- **余额**：`GET /user/balance` 实时查询，5 分钟缓存，失败静默省略该行
- 这是**估算**不是账单，定价可能变动，以 DeepSeek 平台账单为准

## /btw + /recap 拦截小票

dsh-tui 的 `/btw`（侧问）和 `/recap` 都是 plugin 侧直接调 `llm.stream()` 的单次无工具请求——答案不进 session log、不触发 turn 事件，无法靠监听 session/event 捕获。Plugin 在 `apply()` 时 **monkey-patch `llm.stream`** 拦截（完全可逆，dispose 还原）：

- 识别特征：`messages[last-user].source.plugin ∈ {dsh-tui/btw, *recap*}`
- Question：`stripReminder()` 剥 dsh-tui 的 `<system-reminder>` 包装
- Answer：流式 `text-delta` 累积
- 流 done → 单独打一张 **RECAP RECEIPT**（Q/A wrap 到纸宽）

## 小票编码规则（GBK 安全层）

LLM 输出常含 58mm 打印机 GB2312 字库外的字符。Bridge 三层降级：

1. **GBK 字库内**（→ ≤ ≥ α 中文等）→ 原样保留
2. **常见符号查表 30+ 项**：`✓→OK` `✅→[OK]` `⭐→*` `🔥→[!]` `—→--` `≤→<=` `¥→Y`
3. **仍编不出**（emoji、稀有文字）→ `?` 兜底

中文/英文混合换行：**word-boundary wrap**——英文按空格断（不切词），中文按字符断，每行 ≤32 ANK units（58mm 物理宽）。stdin 是 Node utf-8 写 + Python utf-8 读（修复过 GBK 错配 bug）。

## 配置

```yaml
# cordis.patch.yml 的 config 段 (bundle 默认; profile 用户层可 override)
enabled: true            # 总开关
trigger: turn-end        # turn-end | session-end | manual
minIntervalSec: 60       # 防抖 (60s 内不重复打)
autoRecap: true          # LLM 自动任务回执 (合并到同一张)
autoRecapTimeoutSec: 30  # recap 调用硬超时
printSideCalls: true     # /btw /recap 单独打
dryRun: false            # 默认关闭 = 真打印; true 渲染 + stderr 预览不耗纸
pythonCmd: python        # 桥解释器
printerName: Thermal-58  # Win32 打印队列名
```

**Dry-Run 模式**（默认**关闭**，需要时开启）：`dryRun: true` 时 bridge 把渲染字节解码为 ASCII preview 写到 stderr，`THERMAL_DEBUG=1` 下完整落日志。E2E 测试同样默认 dry-run（`PRINT_REAL=1` 才真打）。

## Plugin 文件结构（DSH 官方 bundle 模式）

```
DSH-Receipt-Printer/
├── package.json          # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # insert plugin row + config defaults
├── dsh-plugin.json       # v0.15 manifest (社区共识字段)
├── src/
│   ├── index.ts          # 契约: name / Config (StandardSchemaV1) / apply
│   ├── schema.ts         # 零依赖 StandardSchemaV1 实现
│   ├── collector.ts      # session/event → ReceiptStats + cost 累积
│   ├── recap.ts          # 自动 LLM 任务回执
│   ├── btw.ts            # /btw /recap 拦截 (可逆 llm.stream wrap)
│   ├── pricing.ts        # 峰谷感知 CNY 计费
│   ├── balance.ts        # /user/balance 余额
│   ├── bridge.ts         # spawn Python 桥 (30s 安全超时)
│   ├── events.ts         # receipt/printed 事件类型
│   ├── registration.ts   # KNOWN_SESSION_EVENT_TYPES 注册 (resume 安全)
│   └── dsh-session.d.ts  # ambient SessionEventMap merge
├── lib/                  # tsc 输出（已提交, Git 安装即用, 不依赖 prepare）
├── vendor/
│   └── thermal_bridge.py # 自包含 Python 桥 (UTF-8 stdin → ESC/POS → spooler)
└── test/
    ├── e2e.mjs           # 45 项端到端测试
    └── stdin_encoding.mjs
```

## 安全 / 合规声明（来自 DSH 规范）

- **log-only 事件**：`receipt/printed` 仅作 UI/debug 状态，模型永远看不到（无 `surfaceOp`）
- **事件类型注册**：`src/registration.ts` 把事件类型加入每个可达 dsh-session 副本的 `KNOWN_SESSION_EVENT_TYPES`（双锚点 `import.meta.url` + `process.argv[1]`，幂等、永不抛错）——**不注册会让整个 session 无法 resume**（硬规则）
- **v0.15 manifest**：仅声明 `manifestVersion` / `identity` / `facets.host` / `requires.contracts` / `permissions` / `subscriptions`，**无** `provides`/`services` facets（v0.15 拒绝）
- **权限**：`process.spawn`（仅用于调起 bundled Python 桥）
- **API key 不落仓库**：桥通过 DSH llm 服务调用，余额查询按 `env DEEPSEEK_API_KEY > ~/.dsh/.credentials.yaml` 优先级解析

## 版本兼容矩阵（关键）

**dsh-tui 与 dsh CLI 版本必须配对**。DSH 内部依赖 `^0.1.2-alpha.2` 这类 prerelease range 会被 npm/pnpm 解析到最新 rc，造成 Session API 断层（`session.events` getter 在 alpha.4 起被改名 `snapshotEvents()`）→ dsh-tui 启动报 `events is not iterable`。修复方式：用 npm `overrides` 把所有 `@deepseek-ai/dsh-*` 显式钉到同一 alpha 版本（见 `.tools/dsh-pinned/package.json` 模板，不在 git 内）。

| 组件 | 已验证版本 | 说明 |
|---|---|---|
| Node | 24.11.0 | DSH zstd 硬依赖 ≥22.15 |
| dsh CLI | 0.1.2-alpha.2/3（内部包全钉同版） | dsh-tui peer 范围 |
| dsh-tui | 0.10.0-beta.5 | launcher 全局命令 `dsh-tui` |
| pnpm | 11.25.0 | profile 内插件管理 |
| 本 plugin | 0.2.0 | headless / dsh-tui / desktop 三 profile 实测 |

## 硬件适配

- 58mm 热敏打印机（VID_0483 STM32 方案，常见山寨机型）
- Windows 打印队列 `Thermal-58`，驱动 `Generic / Text Only`，端口 USB 动态监视器透传 ESC/POS 字节
- 384 dots / 32 ANK units 每行；中文 GBK 编码（打印机内置 GB2312 点阵字库）
- 图块仅用 `■`/`□`（GB2312 安全字符）；切刀 `GS V` 全切（无切刀机型自动忽略）

## 验证

```sh
npm install && npm run build       # 构建产物 lib/ 已提交, 通常可跳过
npm test                           # 45 项端到端测试 (默认 dry-run 不耗纸)
PRINT_REAL=1 npm test              # 含真实物理打印
python vendor/thermal_bridge.py --printer Thermal-58 --dry-run <<<'{"sessionId":"manual","turns":1}'
```

## 设计原则

- **KISS**：核心 ~1000 行 TS + ~400 行 Python，零第三方 Python 依赖，单进程一次性执行
- **SRP**：采集 / 渲染 / 打印 / 计费 / 余额 / 回执六层完全解耦，可独立测试
- **DRY**：ESC/POS 渲染原语（`line/center/kv/divider/bar/qr`）统一封装
- **YAGNI**：v0.1 只做"DSH session → 一张小票"

## Roadmap

### 多 Agent 工具支持

- [ ] **Claude Code**（`~/.claude/projects/*.jsonl` transcript 输入侧适配器）
- [ ] **Codex CLI / cx** 等其他 agent 工具的 session/transcript 输入侧
- [ ] OpenTelemetry 统一采集层（参考 ai-coding-agent-observatory 架构）

### 打印体验

- [ ] `SessionEnd` hook 自动触发（替代 turn/end，更准确的"任务结束"语义）
- [ ] SQLite 累积多 session 历史
- [ ] Aggregation window（10~30min / milestone 才吐一张，避免刷屏）
- [ ] HTML → 1-bit dithering → 图像模式打印（图标、富表格）
- [ ] 跨机架构：GPU server → HTTP → 树莓派 + ESC/POS daemon

### 生态

- [ ] npm publish（`dsh plugin add dsh-receipt-printer` 一行安装）
- [ ] dsh-tui-ecosystem / dsh.pub 目录收录
- [ ] dsh-plugin.json v0.15 真实 Host 准入认证

## License

MIT — see [LICENSE](LICENSE)
