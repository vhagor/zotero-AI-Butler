# API 配置指南

本指南详细介绍如何配置各大 AI 平台的 API，让 AI 管家为您工作。

## 支持的平台

AI 管家目前支持以下 8 种 API 接入方式：

| 平台                 | 接口类型                          | 适用场景                                                                                |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| **Google Gemini**    | 原生 Gemini API                   | 多模态能力强，支持直接读取 PDF                                                          |
| **OpenAI**           | OpenAI 新接口(v1/responses)       | GPT 系列模型                                                                            |
| **Anthropic Claude** | 原生 Claude API                   | Claude 系列模型                                                                         |
| **OpenAI 兼容**      | OpenAI 兼容接口(chat/completions) | 第三方服务商（硅基流动、DeepSeek 等）                                                   |
| **OpenRouter**       | 统一 LLM 接口                     | 🌐 聚合数百种模型，一个 API 通用                                                        |
| **火山方舟**         | 火山引擎 Responses API            | 🆕 豆包大模型，每日200万tokens免费                                                      |
| **Ollama**           | 本地 Ollama `/api/chat`           | 本地/局域网大模型，通常无需 API 密钥                                                    |
| **Cursor Agent**     | 本地 `cursor-agent` CLI 子进程    | 🆕 直接调用 Cursor 自家模型（Composer / GPT‑5.x / Claude / Gemini），按 Cursor 订阅计费 |

---

## Google Gemini 配置

### 获取 API 密钥

1. 访问 [Google AI Studio](https://aistudio.google.com/)
2. 使用 Google 账号登录
3. 点击左侧 **"Get API key"** → **"Create API key"**
4. 复制生成的 API 密钥
5. 确保配额层级不是 **"不可用"**，否则无法使用 API。若所有 API 配额都为 **"不可用"**，建议更换 Google 账号。

![AI Studio 配额层级](images/api-config-gemini-quota.png)

### 在插件中配置

1. 打开 **AI 管家仪表盘** → **快捷设置**
2. 进入 **模型平台** 页面，添加或展开 **Gemini**
3. 粘贴 API 密钥
4. 模型名称填写（例如：`gemini-2.5-flash`、`gemini-3-flash-preview` 等，确保模型名称正确，模型名称可从[Google Gemini API 文档](https://ai.google.dev/gemini-api/docs/models)获取）
5. 点击 **"测试连接"**

![Gemini API 配置](images/quick-start-google-gemini-api-config.png)

![Gemini API 测试连接](images/quick-start-google-gemini-api-test.png)

### 免费层级限制说明

Google AI Studio 免费层级对不同模型有不同的速率限制。查看可用的模型和限制：

1. 访问 [AI Studio 用量页面](https://aistudio.google.com/usage)
2. 点击 **"速率限制"**
3. 选择 **"所有模型"** 查看各模型的免费额度

![AI Studio 免费层级模型列表](images/api-config-gemini-rate-limits.png)

> ⚠️ **注意**：上图截取于 2025 年 12 月 22 日，Google 可能随时调整免费层级支持的模型和配额，请以实际页面为准。

---

## OpenAI 配置

### 官方文档

- **API 文档**：[OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- **模型列表**：[OpenAI Models](https://platform.openai.com/docs/models)
- **定价**：[OpenAI Pricing](https://openai.com/api/pricing/)

### 获取 API 密钥

1. 访问 [OpenAI Platform](https://platform.openai.com/)
2. 登录后进入 **Dashboard** → **API Keys**
3. 点击 **"Create new secret key"**
4. 复制生成的密钥（只显示一次，请妥善保存）

### 在插件中配置

1. 打开 **AI 管家仪表盘** → **快捷设置**
2. 进入 **模型平台** 页面，添加或展开 **OpenAI**
3. 粘贴 API 密钥
4. 模型名称填写（从 [官方模型列表](https://platform.openai.com/docs/models) 获取，模型名在Snapshots下，例如：`gpt-5.2`、`gpt-5-mini`）
5. 如使用支持推理的 GPT / o 系列模型，可在 **模型平台** 页面展开对应模型详情并调整 **思维链长度**；OpenAI 官方端点默认使用 **斟酌**
6. 点击 **"测试连接"**

![OpenAI 模型名获取](images/api-config-openai-models.png)

---

## Anthropic Claude 配置

### 官方文档

- **API 文档**：[Anthropic API Reference](https://docs.anthropic.com/en/api/getting-started)
- **模型列表**：[Anthropic Models](https://platform.claude.com/docs/en/about-claude/models/overview)
- **定价**：[Anthropic Pricing](https://www.anthropic.com/pricing)

### 获取 API 密钥

1. 访问 [Anthropic Console](https://console.anthropic.com/)
2. 注册并登录账号
3. 进入 **Settings** → **API Keys**
4. 点击 **"Create Key"** 创建密钥

### 在插件中配置

1. 打开 **AI 管家仪表盘** → **快捷设置**
2. 进入 **模型平台** 页面，添加或展开 **Anthropic**
3. 粘贴 API 密钥
4. 模型名称填写（从 [官方模型列表](https://platform.claude.com/docs/en/about-claude/models/overview) 获取，例如：`claude-opus-4-5`）
5. 点击 **"测试连接"**

---

## OpenAI 兼容接口（第三方平台）

许多第三方 AI 服务商提供兼容 OpenAI Chat Completions 格式的 API。配置时需要从各平台官方文档获取：

- **Base URL**：API 服务地址
- **模型名称**：平台支持的模型标识符

### 常见平台文档

| 平台         | API 文档                                                                                           | Base URL                                                |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **硅基流动** | [SiliconFlow Docs](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions) | `https://api.siliconflow.cn/v1/chat/completions`        |
| **DeepSeek** | [DeepSeek API](https://api-docs.deepseek.com/)                                                     | `https://api.deepseek.com/v1/chat/completions`          |
| **智谱 AI**  | [GLM API](https://open.bigmodel.cn/dev/api)                                                        | `https://open.bigmodel.cn/api/paas/v4/chat/completions` |
| **Moonshot** | [Kimi API](https://platform.moonshot.cn/docs/api/chat)                                             | `https://api.moonshot.cn/v1/chat/completions`           |

### 配置方法

1. 打开 **AI 管家仪表盘** → **快捷设置**
2. 进入 **模型平台** 页面，添加或展开 **OpenAI 兼容**
3. 填写以下信息：
   - **API 密钥**：从第三方平台控制台获取
   - **API 地址**：填写上表Base URL或参考平台官方文档
   - **模型名称**：从平台官方文档获取（注意大小写和格式）

### 硅基流动配置示例

1. 访问 [硅基流动官网](https://siliconflow.cn/) 注册账号
2. 在控制台 → API Keys 获取密钥
3. 在 [模型列表](https://docs.siliconflow.cn/cn/docs/model-names) 选择模型
4. 在插件中配置：
   - **Base URL**：`https://api.siliconflow.cn/v1`
   - **模型名称**：例如 `Qwen/Qwen2.5-72B-Instruct`

### DeepSeek 配置示例

1. 访问 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册账号
2. 获取 API 密钥
3. 参考 [模型文档](https://api-docs.deepseek.com/zh-cn/) 选择模型
4. 在插件中配置：
   - **Base URL**：`https://api.deepseek.com/v1`
   - **模型名称**：例如 `deepseek-chat`

---

## OpenRouter 配置

OpenRouter 提供统一的 LLM API 接口，聚合了数百种 AI 模型，让您能够通过一个 API 密钥访问来自 OpenAI、Anthropic、Google、Meta 等多家厂商的模型。

### 官方文档

- **官网**：[OpenRouter](https://openrouter.ai/)
- **API 文档**：[OpenRouter Docs](https://openrouter.ai/docs)
- **模型列表**：[OpenRouter Models](https://openrouter.ai/models)
- **价格**：[OpenRouter Pricing](https://openrouter.ai/pricing)

### 获取 API 密钥

1. 访问 [OpenRouter](https://openrouter.ai/)
2. 注册账号（支持 Google 登录）
3. 进入 **Dashboard** → **Keys**
4. 创建新的 API Key

### 推荐理由

- 🌐 **模型丰富**：一个 API 访问 GPT-5、Claude、Gemini、Llama 等数百种模型
- 💰 **灵活定价**：按需付费，不同模型价格透明
- 🔄 **高可用性**：自动故障转移，保证服务稳定

### 在插件中配置

1. 打开 **AI 管家仪表盘** → **快捷设置**
2. 进入 **模型平台** 页面，添加或展开 **OpenRouter**
3. 填写以下信息：
   - **API 地址**：`https://openrouter.ai/api/v1/chat/completions`
   - **API 密钥**：从 OpenRouter Dashboard 获取
   - **模型名称**：例如 `google/gemini-3-pro-preview`、`openai/gpt-5.2`
4. 点击 **"测试连接"**

> 💡 **提示**：在 [模型列表](https://openrouter.ai/models) 页面可查看所有可用模型及其价格。

---

## 火山方舟（豆包大模型）配置

火山引擎旗下的大模型服务平台，提供豆包 (Doubao) 系列大模型，支持多模态理解。

### 官方文档

- **API 文档**：[火山方舟 Responses API](https://www.volcengine.com/docs/82379/1902647)
- **模型列表**：[豆包大模型](https://www.volcengine.com/docs/82379/1330310)
- **控制台**：[火山方舟控制台](https://console.volcengine.com/ark)

### 获取 API 密钥

1. 访问 [火山引擎控制台](https://console.volcengine.com/)
2. 注册并完成实名认证
3. 进入 **火山方舟** → **API Key 管理**
4. 创建 API Key

### 推荐模型

| 模型名称                 | 特点                  |
| ------------------------ | --------------------- |
| `doubao-seed-1-8-251228` | 🌟 推荐，多模态能力强 |
| `doubao-seed-1-6-250615` | 性价比高              |

### 免费额度

🎁 **每日 200 万 tokens 免费**，足够个人日常使用。

### 在插件中配置

1. 打开 **AI 管家仪表盘** → **快捷设置**
2. 进入 **模型平台** 页面，添加或展开 **火山方舟 (Volcano Ark)**
3. 填写以下信息：
   - **API 地址**：`https://ark.cn-beijing.volces.com/api/v3/responses`
   - **API 密钥**：从火山方舟控制台获取
   - **模型名称**：例如 `doubao-seed-1-8-251228`
4. 点击 **"测试连接"**

> ⚠️ **注意**：火山方舟现在使用 Responses API（`/api/v3/responses`）而非旧的 Chat Completions API。如果您之前配置了旧地址，请点击 **"重置默认"** 按钮更新配置。

---

## Ollama 本地模型配置

Ollama 适合调用本机或局域网内运行的大模型服务。AI 管家会使用 Ollama 原生 `/api/chat` 接口，并可从 `/api/tags` 获取本地模型列表。

### 准备 Ollama

1. 安装并启动 Ollama。
2. 拉取需要的模型，例如：`ollama pull llama3.2` 或 `ollama pull qwen2.5:7b`。
3. 确认服务地址可访问，默认是 `http://localhost:11434`。

### 在插件中配置

1. 打开 **AI 管家仪表盘** → **快捷设置**。
2. 进入 **模型平台** 页面，添加或展开 **Ollama**。
3. 填写以下信息：
   - **API 地址**：默认 `http://localhost:11434`，也可填写局域网地址。
   - **API 密钥**：本地 Ollama 通常留空；如果你的反向代理设置了鉴权，则填写 token。
   - **模型名称**：例如 `llama3.2`、`qwen2.5:7b`、`deepseek-r1:8b`。
4. 点击 **"测试连接"**。

> 注意：Ollama 原生接口不支持直接上传 PDF Base64。使用 Ollama 阅读论文时，请在 **模型平台** 页面展开该模型详情，在 **PDF 处理方式** 选择 **文本提取** 或 **MinerU**；也可以在 **API 配置** 页面把全局 PDF 处理模式改为文本提取。AI 管家不会静默改写您选择的 PDF 处理模式；如果仍选择 Base64，会显示明确错误。

---

## Cursor Agent（本地 CLI）配置

Cursor Agent provider 通过本地 [Cursor CLI](https://cursor.com/cli)（`cursor-agent`）以子进程方式调用 Cursor 自家模型，无需 OpenAI / Anthropic / Google 等第三方 API 密钥，按 Cursor 订阅计费。

适用人群：

- 已有 Cursor Pro / Business 订阅，想把 Cursor 的额度复用到 Zotero 阅读流程中
- 希望避免在 Zotero 中明文存放 OpenAI / Anthropic API 密钥
- 想随时通过 `--model` 切换 Cursor 支持的 Composer、GPT‑5.x、Claude Sonnet/Opus、Gemini 等模型

### 前置条件

1. **安装 Cursor CLI（必须，AI 管家不会自动下载）**：

   ```bash
   # macOS / Linux / WSL
   curl https://cursor.com/install -fsS | bash
   # Windows PowerShell
   irm https://cursor.com/install.ps1 | iex
   ```

   安装完成后默认路径：
   - macOS / Linux：`~/.local/bin/agent`
   - Windows：`%LOCALAPPDATA%\Programs\cursor\agent.exe`

2. **完成认证**（任选其一）：
   - **推荐**：在终端运行 `agent login`，按提示在浏览器中完成 Cursor 账号登录，凭据会写入本机；AI 管家此时无需填写 API Key
   - 或者：在 [Cursor 控制台 → API Keys](https://www.cursor.com/dashboard?tab=integrations) 申请一个 `CURSOR_API_KEY`，填入下方"API 密钥"输入框

3. （可选）验证安装：

   ```bash
   agent --version
   agent models   # 列出当前账号可用的模型
   ```

### 在插件中配置

1. 打开 **AI 管家仪表盘** → **快捷设置** → **模型平台**
2. 点击 **添加模型**，**供应商类型** 选择 **Cursor Agent**
3. 填写以下字段：
   - **cursor-agent 可执行文件路径**（可选）：留空时插件会在 `~/.local/bin/agent`、`/opt/homebrew/bin/agent`、`%LOCALAPPDATA%\cursor-agent\agent.cmd`、`%LOCALAPPDATA%\Programs\cursor\agent.exe` 等候选位置自动探测；Windows 下 cursor 官方 `irm 'https://cursor.com/install?win32=true' | iex` 装出来的就是 `%LOCALAPPDATA%\cursor-agent\agent.cmd`，可以直接填这条。也可以点 **自动探测** 按钮一键填入。
     > **Windows 提示**：插件能直接识别 `.cmd` / `.ps1` / `.bat` 路径——遇到 cursor 自家 launcher（`agent.cmd` / `agent.ps1`）时还会自动绕过其已知的版本目录命名 bug，直接定位到内嵌的 `versions\<latest>\node.exe + index.js` 并直跑，不依赖 `agent.ps1` 本体能否启动。
   - **API 密钥**（可选）：填入 `CURSOR_API_KEY` 即可不依赖本地 `agent login`；若留空，AI 管家不会注入该环境变量，CLI 会使用本机已缓存的登录凭据。
   - **模型**：例如 `composer-2.5`、`gpt-5.1`、`claude-sonnet-4.5`、`gemini-3-pro-preview`。可点击 **获取模型** 触发 `agent models` 拉取当前账号的可用模型列表。
4. 在同一面板下方的 **⚙ Cursor Agent CLI 参数（全局生效）** 区块，根据需要调整：
   - **运行模式**：默认 **Ask**（只读 Q&A，不调用任何工具，最安全；推荐保留），需要让模型主动读取本地文件时才切到 **Agent**
     > 与 CLI 的对应关系（新版 cursor-agent CLI 已把 `--mode` 收窄为 `plan` / `ask`）：**Ask** = `--mode ask`，**Plan** = `--mode plan`，**Agent** = 省略 `--mode`（CLI 默认即 agent 模式）+ `-f`（命令免交互批准）。
   - **工作目录**：传给 `cursor-agent --workspace` 的路径。Ask 模式下基本无影响；Agent 模式建议指定一个空目录避免误触发文件读取
   - **附加 CLI 参数**：透传给 `cursor-agent` 的额外参数，按空格分隔、支持双引号包裹带空格的值。仅供高级用户
5. 点击 **测试连接**：成功会显示当前模型、Session ID 和凭据来源（`env` 或 `agent login`）

### PDF 直传（Base64）的工作方式

把 PDF 处理方式保持为默认的 **多模态 (Base64)** 时，Cursor Agent provider 会：

1. 把 Base64 解码后写入 Zotero 临时目录下一个一次性子目录（路径形如 `<TempDir>/ai-butler-cursor-<ts>-<rand>/paper.pdf`）
2. 临时强制本次调用使用 **Agent 模式** 并把 `--workspace` 指向上一步那个子目录
3. 在 prompt 里告诉 cursor-agent："工作目录中有一份 `./paper.pdf`，请用文件读取工具读出后再回答"
4. 调用结束（成功或失败）后立即递归删除该子目录

> 这意味着即使你在"运行模式"里设置了 Ask / Plan，PDF 直传那一次调用仍然会被强制升级为 Agent + `--trust`，否则模型没办法读到文件。你设置的"工作目录"也会被这次调用临时覆盖，不会被持久写入。

如果你使用的模型在 cursor-agent 工具调用里读不到 PDF（典型表现：模型回信说"我无法直接读取二进制 PDF"），请把该 endpoint 的 **PDF 处理方式** 切换为 **文本提取** 或 **MinerU**。

### 多轮对话续聊（`--resume`）

为了节省 token 并提升响应速度，Cursor Agent provider 在 chat 多轮场景下会自动复用上一次返回的 `session_id`：

- 每次成功调用后，插件会把当次 conversation 指纹与 cursor-agent 返回的 `session_id` 存进进程内 LRU 缓存（容量 32，插件重启即清空）
- 下一轮 chat 时，如果新 conversation 的前缀（除最末一条 user 消息外）能与缓存中的某条历史完全对上，就只把最新一条 user 消息发出去并附加 `--resume <session_id>`
- 续聊调用若失败（例如服务端会话已被 GC），插件会清掉这条缓存并自动用完整 conversation 重发一次，对用户无感

需要关闭这个行为（例如调试时希望每轮都重发完整上下文），把 `extensions.zotero.aiButler.cursorAgentResumeEnabled` 设为 `false` 即可。Base64 PDF 直传那条路径不参与续聊（每次 workspace 不同，强制 resume 会让模型答非所问）。

### 限制与注意事项

- **不支持 temperature / top_p / max_tokens**：CLI 没有对应入口，相关字段会被忽略。`reasoningEffort` 也不会下发，由 Cursor 模型自行决定。
- **运行环境**：插件通过 Mozilla `Subprocess` 模块启动子进程，仅支持 Zotero 7+。Zotero 6 / 5 无法使用本 provider。
- **多 PDF 附件**：目前 Cursor Agent provider 不支持一次性处理多个 PDF，建议在多 PDF 模式中选择"仅默认 PDF"。
- **隐私**：每次调用会把"系统提示 + 论文文本/对话历史"通过子进程 stdin 一次性传给 `cursor-agent`，并由 Cursor 后端处理；行为与你在 Cursor IDE 中向模型提问一致。

### 故障排查

| 现象                                                                                        | 可能原因                                                                                                                           | 解决方式                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试连接报 `未找到 cursor-agent 可执行文件`                                                 | CLI 未安装或装在非常规位置                                                                                                         | 按上文步骤安装；或在"cursor-agent 可执行文件路径"中填入绝对路径                                                                                                                                       |
| 终端跑 `agent` 报 `agent.ps1: No version directories found ...`                             | cursor win 安装脚本写出的版本目录名格式（`YYYY.MM.DD-HH-MM-SS-commit`）与 `agent.ps1` 中的正则（只接受 `YYYY.MM.DD-commit`）不一致 | 只影响**终端**直接调 `agent`；**插件不受影响**（已自动绕过 ps1 直跑 `node.exe + index.js`）。如果想让终端也能用，把 `%LOCALAPPDATA%\cursor-agent\versions\<目录名>` 改名删掉中间的 `-HH-MM-SS` 段即可 |
| 测试连接报 `File at path "/.local/bin/agent" does not exist`                                | 老版本插件 Windows 平台探测失败 + `${HOME}` 在 Windows 下展开为空                                                                  | 升级到包含本节修复的版本（≥ 3.8.0），或手动在路径里填入 `%LOCALAPPDATA%\cursor-agent\agent.cmd`                                                                                                       |
| 任务报 `option '--mode <mode>' argument 'agent' is invalid. Allowed choices are plan, ask.` | 新版 cursor-agent CLI 已移除 `--mode agent`，agent 模式现在是省略 `--mode` 时的 CLI 默认行为                                       | 升级到包含本节修复的版本（≥ 3.8.0）；该版本会按新规则构造 argv（agent → 省略 `--mode` + `-f`）                                                                                                        |
| 测试连接报 `退出码 X` 且 stderr 包含 `not logged in`                                        | 既没填 `CURSOR_API_KEY` 也没执行 `agent login`                                                                                     | 在终端执行 `agent login`，或在插件中填入 `CURSOR_API_KEY`                                                                                                                                             |
| 模型回信说"我读不到 PDF"或回答内容明显不是基于论文                                          | 当前模型在工具调用里无法解析 PDF 二进制                                                                                            | 把该 endpoint 的 PDF 处理方式改为"文本提取"或"MinerU"                                                                                                                                                 |
| 摘要长时间无响应直到 `执行超时`                                                             | 模型本身慢 / 网络问题                                                                                                              | 提高 **快捷设置 → 通用 → 请求超时** 阈值；或换更轻量的模型（如 `composer-2.5`）                                                                                                                       |
| 多轮对话中模型回复"我不记得之前的内容了"                                                    | sessionId 服务端已 GC，插件已自动回退                                                                                              | 一般无需干预；反复发生可临时关闭 `cursorAgentResumeEnabled`                                                                                                                                           |

---

## PDF 处理模式

AI 管家提供统一的 PDF 输入中间件。您可以在 **API 配置** 页面设置全局默认 PDF 处理方式，也可以在 **模型平台** 页面为每个模型单独覆盖。这样同一套路由中可以让 Gemini/GPT-4o 使用 Base64，让 Ollama、部分 OpenAI-compatible 中转模型使用文本提取或 MinerU。

| 模式                | 说明                            | 适用场景                              |
| ------------------- | ------------------------------- | ------------------------------------- |
| **多模态 (Base64)** | 将 PDF 编码后发送给模型         | 支持多模态的模型（如 Gemini、GPT-4o） |
| **文本提取**        | 提取 PDF 文字内容发送           | 不支持多模态的模型                    |
| **MinerU**          | 使用 MinerU 提取高质量 Markdown | 公式、表格和复杂排版较多的论文        |

选择 **MinerU** 后，可以继续配置解析模型版本：**VLM** 是推荐的高质量解析模型，**Pipeline** 是更轻量的模型，适合速度优先或额度敏感的场景。

### 切换方法

1. 打开 **AI 管家仪表盘** → **快捷设置**
2. 进入 **API 配置** 页面，找到 **"全局 PDF 处理模式"** 设置默认行为
3. 如果某个模型需要单独设置，进入 **模型平台** 页面并展开对应模型详情，在 **"PDF 处理方式"** 中选择覆盖模式

> 💡 **提示**：如果遇到 "The model is not a VLM"、中转站不兼容 PDF 输入等 API 报错，优先给这个模型单独切换为 **文本提取** 或 **MinerU**。其他支持 Base64 的模型可以继续保留多模态模式。

### 多 PDF 附件

当论文条目包含多个 PDF 时，可以在 **"多 PDF 附件模式"** 中选择：

| 模式           | 说明                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| **仅默认 PDF** | 使用最早添加的 PDF 附件                                                                     |
| **全部 PDF**   | 当前 Provider 支持多 PDF 时上传多个附件；不支持时显示错误，请切换为默认 PDF 或更换 Provider |

思维导图、填表、文献综述和后续追问现在共用同一套 LLM 输入中间件，因此 **文本提取模式会对所有这些功能生效**。

---

## gcli2api 免费方案（进阶）

如果您希望免费使用 Gemini 模型但遇到 API 限制，可以参考 [gcli2api](https://github.com/su-kaka/gcli2api) 方案。

详细部署教程请参阅：[Discussion #54 - gcli2api 配置教程](https://github.com/steven-jianhao-li/zotero-AI-Butler/discussions/54#discussioncomment-15199692)

---

## 下一步

- 遇到配置问题？查看：[常见问题 FAQ](faq.md)
- 遇到报错？查看：[故障排除](troubleshooting.md)
