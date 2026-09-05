# thermal-printer / dsh-thermal-receipt

> **Agent 工作小票** — 把每个 DSH agent session 的关键统计 + LLM 自动任务回执打成一张 58mm 物理热敏小票。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blueviolet)](https://github.com/deepseek-ai/deepseek-harness)
[![Tests](https://img.shields.io/badge/tests-45%2F45-brightgreen)](test/e2e.mjs)

```
DSH RECEIPT                          ──────
2026-09-06 01:13        host dsh-tui
项目        thermal-printer
时长                  00:23:45
轮次                          3
模型         deepseek-v4-flash
工具调用 (35)
Edit   ■■■■■■■■■■            17
Bash   ■■■■■■□□□□            12
产出文件 (4)
+ collector.ts  + renderer.py
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

## 快速开始

```sh
# 前置: Node ≥ 22.15 (DSH zstd 依赖, 推荐 24)、pnpm ≥ 10、Python 3.10+
#       一台已配好 Win32 打印队列的 58mm ESC/POS 热敏打印机
dsh plugin add "github:AdamPlatin123/thermal-printer"
# 或本地路径
dsh plugin add "file:/path/to/thermal-printer"
# 重启 dsh-tui / dsh-desktop, 对话一轮 → turn 结束自动吐小票
```

**Your DSH plugin for thermal receipts** — works in dsh-tui (TTY) and dsh-desktop (Electron) through the same core `session/event` seam.

**双形态交付**：

| 形态 | 入口 | 挂钩目标 | 状态 |
|---|---|---|---|
| **DSH Plugin**（主形态） | `dsh plugin add` 装入任何 DSH profile | **dsh-tui**（chimney TTY）+ **dsh-desktop**（anywherelab Electron）| ✅ 可分发 |
| Claude Code CLI 工具 | `python main.py` | `~/.claude/projects/` 下的 JSONL transcript | ✅ 可用 |

DSH Plugin 与 CLI 工具共享同一台打印机（58mm ESC/POS，Win32 spooler raw print）和同一套小票版式（DSH RECEIPT / AGENT RECEIPT）。

---

## 一、DSH Plugin 形态

### 工作原理

```
DSH Host (dsh-tui 或 dsh-desktop, 同一 Cordis 运行时)
        │
        ├── session/event (turn/start | assistant/chunk | tool/call | tool/result | turn/end)
        ▼
src/collector.ts        ReceiptCollector 累积 per-session stats
        │ turn/end 时触发 (config.trigger, 可选 session-end / manual)
        ▼
src/bridge.ts           spawn(pythonCmd, [vendor/thermal_bridge.py])
        │ stats JSON → stdin
        ▼
vendor/thermal_bridge.py  stats JSON → ESC/POS 字节 (58mm / GBK / ■□)
        │
        ▼
Win32 spooler raw print → Thermal-58 → 🧾
```

**核心 seam 选择**：只用 `session/event` / `session/disposed` 这两个 DSH **核心 seam**，不用任何 TUI-only 服务（`ctx.tuiStatus` 等）——这保证同一份代码在 dsh-tui（TTY）和 dsh-desktop（Electron/Web）两个 host 中无需修改同时工作。`commands` 服务软探测（`ctx.get('commands', false)` 风格），缺了不阻塞启动（#183 原则）。

### 安装到 dsh-tui

**用户日常使用（已完成安装）**：本机已部署完毕，直接在 PowerShell / Windows Terminal 里：

```powershell
dsh-tui              # 启动 TUI（等价 dsh --profile dsh-tui）
# TUI 内对话一轮，turn 结束时打印机会自动吐出 DSH RECEIPT
```

**全新机器安装（从零复刻）**：

```sh
# 前置: Node ≥ 22.15（DSH zstd API 硬要求，推荐 24）、pnpm ≥ 10、Python 3.10+、Thermal-58 打印队列
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui pnpm@latest
dsh plugin --profile dsh-tui add "@deepseek-harness-tui/dsh-tui"
dsh plugin --profile dsh-tui add "file:G:/_Projects/thermal-printer"   # 或 github:<user>/thermal-printer
dsh-tui
```

**Node 升级提示**：DSH 内部依赖 `^0.1.2-alpha.2` 这类 prerelease range，pnpm/npm 会把内部包解析到最新 rc 版本造成 Session API 断层。本仓库附带 `.tools/dsh-pinned/package.json`（全部 `@deepseek-ai/dsh-*` 显式 overrides 钉到同一 alpha 版本）作为可复刻方案，详见 `docs/` 与 README 下文版本矩阵。

### 安装到 dsh-desktop

DSH Desktop（anywhere-labs Electron）用同一 DSH Host + Cordis 机制装载插件。两种路径：

```sh
# 路径 A: 从 GitHub Releases 下载安装 DSH Desktop, 在菜单: Open DSH Terminal, 然后:
dsh plugin add "file:G:/_Projects/thermal-printer"
# 重启 DSH Desktop

# 路径 B: 仅装桌面壳 Cordis 插件包（无 Electron GUI）到一个独立 profile:
dsh plugin --profile desktop add dsh-plugin-desktop        # anywhere-labs 官方 npm 包 v2.0.0
dsh plugin --profile desktop add "file:G:/_Projects/thermal-printer"
```

> ⚠️ Claude Code 自动模式分类器会拦截 `dsh-plugin-desktop` 的非白名单安装 — 在终端手动执行上述命令即可。

### DSH 真实事件契约（已实测验证）

DSH 事件结构是 `{type, seq, time, data}` 四字段包装，**payload 在 `.data`**，字段 camelCase：

| event.type | data 字段 | 我们的用法 |
|---|---|---|
| `turn/start` | `{turn}` | 计数 +1 |
| `turn/end` | `{turn, reason: {kind: 'completed'}}` | **触发打印** |
| `tool/call` | `{turn, step, callId, name, arguments: JSON-string}` | `data.name` 计数 / parse `arguments` 取 `file_path` |
| `assistant/message` | `{turn, step, message, usage?: TokenUsage}` | `data.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` |

### 实测证据（2026-09-05，dsh 0.1.2-alpha.2）

```
headless profile (真实 DeepSeek API turn + 工具调用):
[apply] pid=5068 config={"enabled":true,...}
[maybePrint] trigger=turn-end session=session-3d7eb0bf... tools={"write":1} turns=1
[bridge-result] ok=true stdout=OK printed 858 bytes -> Thermal-58 err=none

dsh-tui profile (plugin 装入 + apply 调用, 启动无 events is not iterable):
+ dsh-thermal-receipt file:G:/_Projects/thermal-printer

headless on alpha.2 (降级后再次端到端):
[apply] pid=65892 config={"enabled":true,...}
[maybePrint] trigger=turn-end session=session-b8b5c701... turns=1
[bridge-result] ok=true stdout=OK printed 673 bytes -> Thermal-58 err=none

desktop profile (dsh-desktop 等价 Cordis 环境, 真实 turn):
[apply] pid=41392 config={"enabled":true,...}
[maybePrint] trigger=turn-end session=session-b928b36b... turns=1
[bridge-result] ok=true stdout=OK printed 673 bytes -> Thermal-58 err=none
```

### 自动 Recap（任务结束 → 一张完善小票）

turn/session 结束时 plugin **主动调 `llm.stream()`** 让 LLM 用中文总结任务（完成/产出/下一步），把总结与统计**合并为同一张小票**：

```
turn/end
   ▼
collector 累积 stats (项目/时长/工具/文件/token)
   ▼
generateRecap(): llm.stream 一次 tool-less 调用
   - provider/model 从 session.requestHeader() 拿 (与 /btw 同源)
   - reasoningEffort: 'off'  ← 关键: reasoning 模型会烧 30s+ 才出文本
   - source.plugin = 'dsh-thermal-receipt' (不含 btw/recap, 自己的 wrap 不拦)
   ▼
answer (中文紧凑 5-8 行)
   ▼
渲染: 统计段 + RECAP 段 + footer → 一张 771+ 字节小票
```

**降级链**：LLM 不可用 / 超时 / 流空 → 自动退回纯统计小票（不阻塞打印）。

**踩坑记录**（都已修）：
1. `content` 必须是 `[{type:'text', text}]` block 数组（裸 string 立即 finish type=error）
2. 必须 `provider`+`model`（缺 provider → `no adapter registered for provider "undefined"`）
3. 必须 `reasoningEffort: 'off'`（不关 reasoning → 3411 个 reasoning-delta 烧满 30s 才被 abort，零文本）

### Dry-Run 模式（默认开启，不耗纸）

```yaml
# cordis.patch.yml (plugin bundle 默认) 或 profile 用户层
- replace:
    - id: dsh-thermal-receipt
      config:
        dryRun: true   # 渲染 + stderr ASCII preview, 零物理打印
```

`dryRun: true` 时 bridge 把渲染字节解码为 ASCII preview 写到 stderr，TS 端在 `THERMAL_DEBUG=1` 时把它写进 `[receipt-preview]...[/receipt-preview]` 块，方便纸贵时验证小票内容。E2E 测试同样默认 dry-run（`PRINT_REAL=1 node test/e2e.mjs` 才真打）。

### /btw + /recap Recap 小票

`/btw`（dsh-TUI 侧问）和 `/recap` 都是 plugin 侧直接调 `llm.stream()` 的**单次无工具请求**——答案不进 session log、不触发 `turn/*` 事件，所以无法靠监听 session/event 捕获。Plugin 在 `apply()` 时 **monkey-patch `llm.stream`** 拦截：

```
llm.stream(options)
   ├─ options.messages 最后一条 user message 的 source.plugin 含 'btw'/'recap'?
   │     ├─ 否 → 原样透传（主 turn 不受影响）
   │     └─ 是 → 包装 AsyncIterable：
   │            ├─ 累积 text-delta chunks → answer
   │            ├─ 剥 <system-reminder>...</system-reminder> 前缀 → 原始 question
   │            └─ 流结束时触发一张 RECAP RECEIPT
```

| 特性 | 实现 |
|---|---|
| 拦截方式 | `wrapLlmForRecap(llm, onComplete)`（src/btw.ts），完全可逆（dispose 还原） |
| 识别特征 | `messages[last-user].source.plugin ∈ {dsh-tui/btw, *recap*}` |
| Question 提取 | `stripReminder()` 剥 dsh-tui 的 `<system-reminder>` 包装 |
| Answer 累积 | 流式 `text-delta` chunks，最多 4096 字符 |
| 触发打印 | 流结束（done）时独立小票：**RECAP RECEIPT** 标题 + Q/A wrap |
| 配置开关 | `printSideCalls: true`（默认开） |
| Lazy 兜底 | apply 时 llm 未 mount → 在第一个 session/event 时再 wrap 一次 |

### 小票编码规则（GBK 安全层）

LLM 输出常含 58mm 打印机 GB2312 字库外的字符。Bridge 的 `to_gbk_safe()` 三层降级：

1. **GBK 字库内**（→ ≤ ≥ α 中文等）→ 原样保留
2. **常见符号查表**：`✓→OK` `✅→[OK]` `⭐→*` `🔥→[!]` `—→--` `≤→<=` `α→a` 等 30+ 项
3. **仍编不出**（emoji、稀有文字）→ `?` 兜底

中文/英文混合换行：**word-boundary wrap**——英文按空格断（不切词），中文按字符断，每行 ≤32 ANK units（58mm 物理宽度）。

### 版本兼容矩阵（关键）

**dsh-tui 与 dsh CLI 版本必须配对**。dsh-tui 0.10.0-beta.x 兼容 DSH 内核 `^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2` —— 装 dsh 0.1.2-rc.1 会因 Session API 变更（`.events` getter → `snapshotEvents()`）在启动时抛 `events is not iterable`。

| 组件 | 已验证版本 | 说明 |
|---|---|---|
| Node | 24.11.0 | DSH zstd 硬依赖 ≥22.15 |
| dsh CLI | **0.1.2-alpha.2/3**（与 dsh-tui 配对） | 内部包需 overrides 钉死（见 `.tools/dsh-pinned/`） |
| dsh-tui | 0.10.0-beta.5 launcher | npm 全局命令 `dsh-tui` |
| pnpm | 11.25.0 | profile 内插件管理 |
| 本 plugin | 0.1.0 | 已装入 headless / dsh-tui / desktop 三个 profile |

### 用户日常使用速查

| 场景 | 命令 | 说明 |
|---|---|---|
| 启动 TUI | `dsh-tui` | 全局命令，等价 `dsh --profile dsh-tui` |
| TUI 内对话 | （对话即可） | 每轮 turn 结束自动打印 DSH RECEIPT |
| headless 测试 | `dsh --profile headless "任务"` | 一次性任务 + 打印 |
| 手动重打 | 在 DSH 内跑 `/receipt` 命令 | host 提供 commands service 时 |
| 关闭打印 | 编辑 profile `cordis.patch.yml` 设 `enabled: false` | 无需卸载 |

### 配置（cordis.patch.yml 的 config 段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `pythonCmd` | `"python"` | Python 解释器（需 ctypes，Windows 自带） |
| `printerName` | `"Thermal-58"` | Win32 spooler 队列名 |
| `trigger` | `"turn-end"` | `turn-end` / `session-end` / `manual` |
| `minIntervalSec` | `60` | 防抖：小于此间隔不重复打（避免刷屏） |
| `bridgePath` | `""` | 覆盖 thermal_bridge.py 路径（默认包内 vendor/） |
| `debug` | `false` | 桥输出诊断 |

### Plugin 文件结构（DSH 官方 bundle 模式）

```
thermal-printer/
├── package.json          # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # insert plugin row + config
├── dsh-plugin.json       # v0.15 manifest (TUI 生态准入, experimental)
├── src/
│   ├── index.ts          # 契约: name / Config (StandardSchemaV1) / apply
│   ├── schema.ts         # 零依赖 StandardSchemaV1 实现
│   ├── collector.ts      # session/event → ReceiptStats
│   ├── bridge.ts         # spawn Python 桥 (30s 安全超时)
│   ├── events.ts         # receipt/printed 事件 + payload 类型
│   ├── registration.ts   # KNOWN_SESSION_EVENT_TYPES 注册 (resume 安全)
│   └── dsh-session.d.ts  # ambient SessionEventMap merge
├── lib/                  # tsc 输出（已提交, Git 安装即用, 不依赖 prepare）
├── vendor/
│   └── thermal_bridge.py # 自包含 Python 桥 (stdin JSON → ESC/POS → spooler)
└── test/e2e.mjs          # 17 项端到端测试 (含真实打印)
```

### 安全/合规声明（来自 DSH 规范）

- **log-only 事件**：`receipt/printed` 仅作 UI/debug 状态，模型永远看不到（无 `surfaceOp`）
- **事件类型注册**：通过 `src/registration.ts` 把事件类型加入每个可达 dsh-session 副本的 `KNOWN_SESSION_EVENT_TYPES`（双锚点：`import.meta.url` + `process.argv[1]`，幂等、永不抛错）——**不注册会让整个 session 无法 resume**，这是硬规则
- **v0.15 manifest**：仅声明 `facets.host` / `subscriptions` / `permissions`（spawn Python 进程）— v0.15 拒绝 `provides`/`services` facets，本插件只订阅不提供
- **权限**：`process.spawn`（仅用于调起 Python 桥打印）

### 验证

```sh
# 1. 构建产物存在（lib/ 已提交, 此步通常可跳过）
npm install && npm run build

# 2. 端到端测试（mock ctx + 真实打印）
npm test

# 3. 手动打印一张
python vendor/thermal_bridge.py --printer Thermal-58 <<< '{"sessionId":"manual-test","turns":1,"project":"test"}'
```

期望输出 `OK printed NNN bytes -> Thermal-58`，同时打印机吐出 `DSH RECEIPT` 小票。

---

## 二、Claude Code CLI 工具形态

## 二、Claude Code CLI 工具形态

```
~/.claude/projects/<slug>/<session-id>.jsonl
        │
        ▼
collector.py    JSONL → SessionStats (dataclass)
        │
        ▼
renderer.py     SessionStats → ESC/POS 字节流 (58mm / 384 dots / GBK)
        │
        ▼
printer.py      Win32 winspool raw print → Thermal-58 (USB002)
```

```bash
# 最新 session 实际打印
python main.py

# 仅屏显（ASCII 预览，不打印）
python main.py --preview

# 保存原始字节（调试 / 后续回放）
python main.py --dry-run out.bin

# 指定 session 文件
python main.py --session "C:\Users\<user>\.claude\projects\<slug>\<id>.jsonl"

# 打印机自检（一行文字 + 切刀）
python printer.py Thermal-58
```

## 模块（SRP）

| 文件 | 职责 | 依赖 |
|---|---|---|
| `collector.py` | 解析 Claude Code session JSONL → `SessionStats` | 标准库 |
| `renderer.py`  | `SessionStats` → ESC/POS 字节流 + ASCII 预览 | 标准库 |
| `printer.py`   | Win32 raw print（`OpenPrinterW/WritePrinter`） | `ctypes` |
| `main.py`      | CLI 入口，粘合三层 | 上面三个 |
| `src/collector.ts` | DSH session/event → ReceiptStats | cordis |
| `src/bridge.ts` | spawn Python 子进程 | 标准库 |
| `vendor/thermal_bridge.py` | 自包含 JSON→ESC/POS→打印 | `ctypes` |

零第三方包，纯 Python 标准库。

## 硬件适配

- 58mm 热敏打印机（VID_0483 STM32 方案，常见山寨机型）
- Windows 打印队列 `Thermal-58`，驱动 `Generic / Text Only`，端口 `USB002`（动态打印监视器透传 ESC/POS 字节）
- 384 dots / 32 ANK units 每行；中文按 GBK 编码（打印机内置 GB2312 点阵字库）
- 图块仅用 `■`/`□`（GB2312 安全字符 A1F6/A1F7）
- 切刀：`GS V` 全切（无切刀机型自动忽略）

## 设计原则

- **KISS**：核心 4 文件 ~500 行，零依赖，单进程一次性执行
- **SRP**：采集 / 渲染 / 打印三层完全解耦，可独立测试
- **DRY**：渲染原语（`line/center/kv/divider/bar/qr`）统一格式化逻辑
- **YAGNI**：第 1 版只做"session → 一张小票"，未实现 SQLite 聚合 / LLM 摘要 / 多 agent 联合（未来扩展点，见下方）

## 未来扩展

参考用户原始愿景（multi-agent observability + 自动摘要 + physical receipt）：

- [ ] `SessionEnd` hook 自动触发打印
- [ ] SQLite 累积多 session 历史
- [ ] Aggregation window（10~30min / milestone 才吐一张，避免刷屏）
- [ ] LLM structured summary（不让 LLM 直接控制打印机，模板层决定输出）
- [ ] HTML → 1-bit dithering → 图像模式打印（支持图标、富表格）
- [ ] 跨机架构：GPU server → HTTP → 树莓派 + ESC/POS daemon
