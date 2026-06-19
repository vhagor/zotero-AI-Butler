/**
 * Cursor Agent (CLI) Provider
 *
 * 通过本地 `cursor-agent` CLI 子进程调用 Cursor 自家模型，无需 OpenAI / Anthropic 等
 * 第三方 API。鉴权方式：
 *   - 优先使用用户在 endpoint / 全局 prefs 中填入的 CURSOR_API_KEY
 *   - 留空时回落到本机 `agent login` 已缓存的凭据
 *
 * 输出协议：`--output-format stream-json --stream-partial-output` 会按行输出 NDJSON：
 *   - `system.init`     : 元数据，含 model / session_id / apiKeySource
 *   - `assistant` (带 timestamp_ms 且无 model_call_id) : 真实的流式 delta
 *   - `assistant` (无 timestamp_ms / 带 model_call_id) : 工具边界处的回放，跳过
 *   - `result`          : 最终权威答案（result.result 字段）
 *   - `error`           : 错误事件
 *
 * 限制：
 *   - 不支持 PDF Base64 输入。请把"PDF 处理"模式切到"文本提取"或 MinerU。
 *   - 不接受 temperature / topP / maxTokens（CLI 无对应入口）。
 *   - 不支持多文件总结（multi-file summary）。
 */

import { ILlmProvider } from "./ILlmProvider";
import {
  APITestError,
  ConversationMessage,
  LLMModelInfo,
  LLMOptions,
  LLMProviderCapabilities,
  ProgressCb,
} from "./types";
import { SYSTEM_ROLE_PROMPT, buildUserMessage } from "../../utils/prompts";
import { getRequestTimeoutMs } from "./shared/llmutils";
import {
  CONNECTION_TEST_TEXT,
  getConnectionTestModeLabel,
} from "./shared/connectionTest";
import {
  createAbortError,
  LLMRequestAbortError,
  normalizeAbortError,
  throwIfAborted,
} from "./shared/requestAbort";

// ------------------------------ Subprocess 类型声明 ------------------------------

/**
 * Mozilla Subprocess Pipe 的最小子集：每次 readString 读取一段已可用的 UTF-8 字符串；
 * 进程退出且管道关闭后会返回 null。
 */
interface SubprocessPipe {
  readString(): Promise<string | null>;
  close?(): Promise<void> | void;
  write?(data: string): Promise<void> | void;
}

interface SubprocessProcess {
  stdout: SubprocessPipe;
  stderr: SubprocessPipe;
  stdin: SubprocessPipe;
  pid: number;
  wait(): Promise<{ exitCode: number }>;
  kill(): void;
}

interface SubprocessOptions {
  command: string;
  arguments?: string[];
  environment?: Record<string, string>;
  environmentAppend?: boolean;
  stderr?: "pipe" | "stdout" | "ignore";
  workdir?: string;
}

interface SubprocessModule {
  call(options: SubprocessOptions): Promise<SubprocessProcess>;
}

// ------------------------------ Provider 实现 ------------------------------

/**
 * Base64 PDF 直传无法实现时的兜底提示。仅当 base64 解码失败或写入临时目录失败时抛出。
 * 普通 base64 流程现在通过 prepareBase64PdfWorkspace 实现"文件直传 + agent --workspace"。
 */
const PDF_BASE64_FILE_ERROR_PREFIX = "Cursor Agent 无法准备 PDF 工作目录";

const DEFAULT_AGENT_PATHS_UNIX = [
  // CursorCLI 官方安装脚本默认位置
  "/root/.local/bin/agent",
  // Linux/macOS 单用户安装位置（用 ${HOME} 占位，运行时再替换）
  "${HOME}/.local/bin/agent",
  // Homebrew / 系统级
  "/opt/homebrew/bin/agent",
  "/usr/local/bin/agent",
  "/usr/bin/agent",
];

const DEFAULT_AGENT_PATHS_WIN = [
  // cursor 官方 `irm https://cursor.com/install?win32=true | iex` 实际装出来的位置
  // —— launcher 是 .cmd / .ps1，本进程会再被 resolveCursorLaunchSpec 转成 node+index.js 直跑
  "${LOCALAPPDATA}\\cursor-agent\\agent.cmd",
  "${LOCALAPPDATA}\\cursor-agent\\cursor-agent.cmd",
  "${LOCALAPPDATA}\\cursor-agent\\agent.ps1",
  "${LOCALAPPDATA}\\cursor-agent\\cursor-agent.ps1",
  // Cursor IDE 内嵌 CLI 的可能位置（如果未来 IDE 自带）
  "${LOCALAPPDATA}\\Programs\\cursor\\agent.exe",
  "${LOCALAPPDATA}\\Programs\\cursor\\resources\\app\\bin\\agent.exe",
  "${LOCALAPPDATA}\\Programs\\cursor-cli\\agent.exe",
  "${APPDATA}\\Cursor\\agent.exe",
  "${ProgramFiles}\\Cursor\\agent.exe",
  // 同时支持 git-bash / WSL 风格安装（HOME 在 Windows 上常为空，由 expandEnv 兜底到 USERPROFILE）
  "${HOME}\\.local\\bin\\agent.exe",
  "${HOME}\\.local\\bin\\agent",
];

/**
 * 用环境变量内插一段路径模板。导出仅供单元测试使用。
 *
 * 特殊兜底：在 Windows 上 `${HOME}` 经常为空，但同等含义的 `USERPROFILE` 一般存在；
 * 反过来在 Unix 上 `USERPROFILE` 不存在但 `HOME` 一定存在。所以当某一边为空时
 * 自动回落到另一个变量，避免出现 `/.local/bin/agent` 这种空字符串展开。
 */
export function expandEnv(
  template: string,
  env: Record<string, string>,
): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const value = env[name];
    if (value) return value;
    if (name === "HOME" && env.USERPROFILE) return env.USERPROFILE;
    if (name === "USERPROFILE" && env.HOME) return env.HOME;
    return "";
  });
}

/**
 * Zotero 7 / Firefox 提供的 OS 平台判断工具。
 *
 * 多信号 OR：Zotero.isWin 是 Zotero 内部最权威的布尔；nsIXULRuntime.OS=="WINNT"
 * 是 XPCOM 层面的最终事实；navigator.platform 和 Zotero.platform 作为最后兜底。
 * 任何一个信号说"是 Windows"就当 Windows，避免单一 API 在某些 Zotero 构建里
 * 返回意外值时整个 fallback 走错。
 */
function isWindowsPlatform(): boolean {
  try {
    const Z = Zotero as any;
    if (Z?.isWin === true) return true;
    if (Z?.isMac === true || Z?.isLinux === true) return false;
    try {
      const Services = (globalThis as any).Services;
      const os = Services?.appinfo?.OS;
      if (os) {
        if (os === "WINNT") return true;
        if (os === "Darwin" || os === "Linux") return false;
      }
    } catch {
      /* ignore */
    }
    const platform =
      Z?.platform ||
      Z?.Platform ||
      (typeof navigator !== "undefined" ? navigator.platform : "");
    if (/win/i.test(String(platform || ""))) return true;
    if (typeof navigator !== "undefined" && navigator.userAgent) {
      if (/windows/i.test(navigator.userAgent)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 加载 Mozilla Subprocess 模块。Zotero 7+ (Firefox 102+) 使用 sys.mjs；
 * 极少数老环境仍可回退到旧 jsm 路径。
 */
function loadSubprocessModule(): SubprocessModule | null {
  try {
    const CU = (globalThis as any).ChromeUtils;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        );
        return (mod?.Subprocess || mod?.default || mod) as SubprocessModule;
      } catch {
        /* fallthrough */
      }
    }
    if (CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        return (mod?.Subprocess || mod) as SubprocessModule;
      } catch {
        /* fallthrough */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 读取当前进程的环境变量（XPCOM nsIEnvironment）。 */
function readProcessEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const Cc = (globalThis as any).Components?.classes;
    const Ci = (globalThis as any).Components?.interfaces;
    if (Cc && Ci) {
      const env = Cc["@mozilla.org/process/environment;1"]?.getService?.(
        Ci.nsIEnvironment,
      );
      if (env) {
        const keys = [
          "HOME",
          "USERPROFILE",
          "LOCALAPPDATA",
          "APPDATA",
          "ProgramFiles",
          "ProgramFiles(x86)",
          "SystemRoot",
          "ComSpec",
          "PATH",
          "Path",
          "USER",
          "USERNAME",
          "SHELL",
          "TMPDIR",
          "TEMP",
          "TMP",
          "LANG",
          "LC_ALL",
        ];
        for (const k of keys) {
          try {
            if (env.exists(k)) result[k] = env.get(k);
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

// ------------------------------ launch spec ------------------------------

/**
 * 把"用户配置的可执行文件路径"转换成 Subprocess.call 能直接用的
 * `{ command, prefixArgs }`。
 *
 * 解决两类 Windows 痛点：
 *   1) Mozilla Subprocess 在 Windows 上**不能**直接 spawn `.cmd` / `.bat` / `.ps1`，
 *      必须通过 `cmd.exe /d /s /c` 或 `powershell.exe -File` 包一层。
 *   2) cursor 官方的 `agent.ps1` / `cursor-agent.ps1` 启动器存在版本目录命名 bug
 *      （目录名实际是 `YYYY.MM.DD-HH-MM-SS-commit`，但 ps1 里的正则要求 `YYYY.MM.DD-commit`，
 *      会报 "No version directories found"）。一旦识别到用户填的是该启动器路径，
 *      就**优先尝试**直接定位到 `versions/<latest>/node.exe` + `index.js`，
 *      用 node 直跑，绕过 buggy 的 ps1。
 *
 * 导出仅供单元测试使用。
 */
export interface CursorLaunchSpec {
  /** Subprocess.call({ command }) */
  command: string;
  /** Subprocess.call({ arguments: [...prefixArgs, ...userArgs, prompt] }) */
  prefixArgs: string[];
  /** 仅供日志/错误信息展示的路径（通常是用户原始填入或最终决定的物理 binary）。 */
  display: string;
  /** 该路径是否被识别为 "Cursor CLI 内嵌 node 启动器" 形式（直跑 index.js）。 */
  viaEmbeddedNode: boolean;
}

const SCRIPT_EXT_RE = /\.(cmd|bat|ps1)$/i;

/** Windows 路径下 `\\` 与 `/` 兼容的最后一段分隔。 */
function splitWinPath(p: string): { dir: string; base: string } {
  const norm = p.replace(/\//g, "\\");
  const idx = norm.lastIndexOf("\\");
  if (idx < 0) return { dir: "", base: norm };
  return { dir: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

/**
 * 判断 binary 是否是 cursor-agent 安装目录下的 launcher 脚本
 * （形如 `<dir>\agent.cmd` / `<dir>\agent.ps1` / `<dir>\cursor-agent.cmd` / `<dir>\cursor-agent.ps1`），
 * 同时确认 `<dir>\versions` 真实存在。返回该 `<dir>` 路径；否则返回空串。
 */
function detectCursorInstallDirSync(binary: string): string {
  if (!binary) return "";
  const { dir, base } = splitWinPath(binary);
  if (!dir) return "";
  if (!/^(agent|cursor-agent)\.(cmd|bat|ps1)$/i.test(base.toLowerCase())) {
    return "";
  }
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils?.existsSync) return "";
  try {
    if (IOUtils.existsSync(dir + "\\versions")) return dir;
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * 在 `<installDir>\versions` 下找最新版本子目录，并返回 `{ node, entry }`。
 * 版本目录格式既兼容 `YYYY.MM.DD-commit`，也兼容 `YYYY.MM.DD-HH-MM-SS-commit`
 * （后者是 cursor 当前 win32 安装脚本实际写出的格式）。
 */
async function locateCursorEmbeddedNode(installDir: string): Promise<{
  node: string;
  entry: string;
} | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils?.getChildren || !IOUtils?.exists) return null;
  const versionsDir = installDir + "\\versions";
  let children: string[];
  try {
    children = (await IOUtils.getChildren(versionsDir)) as string[];
  } catch {
    return null;
  }
  if (!children || children.length === 0) return null;

  // 名字里第一个 "-" 之前一段是 "YYYY.MM.DD"，可直接 lexicographic 比较出最新
  // 之后的 H-M-S 段也是字典序≈时间序，再不行就 commit 段无所谓
  // 但 children 是绝对路径，需要按 basename 比
  const scored = children
    .map((p) => ({ path: p, base: splitWinPath(p).base }))
    .filter((x) => /^\d{4}\.\d{1,2}\.\d{1,2}-/.test(x.base))
    .sort((a, b) => (a.base < b.base ? 1 : a.base > b.base ? -1 : 0));
  if (scored.length === 0) return null;

  for (const cand of scored) {
    const node = cand.path + "\\node.exe";
    const entry = cand.path + "\\index.js";
    try {
      const okNode = await IOUtils.exists(node);
      const okEntry = await IOUtils.exists(entry);
      if (okNode && okEntry) return { node, entry };
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * 把 binary 路径展开为 Subprocess.call 用的启动规格。
 *
 * 平台/后缀决策表：
 *   - `.cmd` / `.bat` + 在 cursor-agent 安装目录 → 直接定位 node.exe + index.js（跳过 buggy launcher）
 *   - `.ps1`         + 在 cursor-agent 安装目录 → 同上
 *   - `.cmd` / `.bat` (其他)                     → `cmd.exe /d /s /c <binary>`
 *   - `.ps1` (其他)                              → `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <binary>`
 *   - 其它（.exe / 裸名 / Unix 路径）            → 直接用
 *
 * 该函数 async：直跑 node 模式下需要 `IOUtils.getChildren` 异步枚举版本目录。
 */
export async function resolveCursorLaunchSpec(
  binary: string,
  env: Record<string, string>,
  isWin: boolean,
): Promise<CursorLaunchSpec> {
  const display = binary;
  if (!binary) {
    return { command: binary, prefixArgs: [], display, viaEmbeddedNode: false };
  }

  if (isWin && SCRIPT_EXT_RE.test(binary)) {
    // 优先尝试"直跑内嵌 node"，绕开 cursor 自家 launcher 的 bug
    const installDir = detectCursorInstallDirSync(binary);
    if (installDir) {
      const found = await locateCursorEmbeddedNode(installDir);
      if (found) {
        return {
          command: found.node,
          prefixArgs: [found.entry],
          display: found.node,
          viaEmbeddedNode: true,
        };
      }
    }
    // 退而求其次：用 cmd.exe / powershell.exe 包一层
    const ext = binary.match(SCRIPT_EXT_RE)![1].toLowerCase();
    if (ext === "ps1") {
      const ps =
        (env["SystemRoot"] || "C:\\Windows") +
        "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      return {
        command: ps,
        prefixArgs: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          binary,
        ],
        display: binary,
        viaEmbeddedNode: false,
      };
    }
    // .cmd / .bat
    const cmdShell =
      env["ComSpec"] ||
      (env["SystemRoot"] || "C:\\Windows") + "\\System32\\cmd.exe";
    return {
      command: cmdShell,
      prefixArgs: ["/d", "/s", "/c", binary],
      display: binary,
      viaEmbeddedNode: false,
    };
  }

  // 普通可执行文件 / Unix
  return { command: binary, prefixArgs: [], display, viaEmbeddedNode: false };
}

/** 拆分用户在"附加参数"输入框中提供的字符串，支持简单的引号包裹。导出仅供单元测试。 */
export function splitExtraArgs(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out.filter((s) => s.length > 0);
}

export type CursorRunMode = "ask" | "agent" | "plan";

/** 把任意输入归一化为合法的 cursor-agent 运行模式。导出仅供单元测试。 */
export function normalizeRunMode(raw: unknown): CursorRunMode {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (value === "agent" || value === "plan") return value;
  return "ask";
}

/**
 * 把一段 base64 PDF 解码后写到 Zotero 临时目录下的一个隔离子目录，并返回
 * cursor-agent 可以 --workspace 指向的路径 + 清理函数。
 *
 * 设计要点：
 *   - 每次调用一个独立子目录，避免并发请求互相串扰
 *   - 工作目录里只有这一个 PDF，cursor-agent 在 agent 模式 + `--trust` 下读取范围被限定
 *   - 调用方必须在结束（成功或失败）后调用 cleanup()
 */
export async function prepareBase64PdfWorkspace(base64: string): Promise<{
  pdfPath: string;
  pdfBasename: string;
  workspaceDir: string;
  cleanup: () => Promise<void>;
}> {
  const cleaned = String(base64 || "")
    .replace(/^data:application\/pdf;base64,/, "")
    .replace(/\s+/g, "");
  if (!cleaned) {
    throw new Error(`${PDF_BASE64_FILE_ERROR_PREFIX}: 空的 base64 输入`);
  }

  let binary: string;
  try {
    binary = (globalThis as any).atob(cleaned);
  } catch (e: any) {
    throw new Error(
      `${PDF_BASE64_FILE_ERROR_PREFIX}: base64 解码失败 (${e?.message || e})`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  let tempRoot = "";
  try {
    tempRoot = ((Zotero as any)?.getTempDirectory?.() as any)?.path || "";
  } catch {
    tempRoot = "";
  }
  if (!tempRoot) {
    throw new Error(
      `${PDF_BASE64_FILE_ERROR_PREFIX}: 无法获取 Zotero 临时目录`,
    );
  }

  const PathUtils = (globalThis as any).PathUtils;
  const IOUtils = (globalThis as any).IOUtils;
  if (!PathUtils?.join || !IOUtils?.makeDirectory || !IOUtils?.write) {
    throw new Error(
      `${PDF_BASE64_FILE_ERROR_PREFIX}: 当前环境缺少 PathUtils/IOUtils（需要 Zotero 7+）`,
    );
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceDir = PathUtils.join(tempRoot, `ai-butler-cursor-${stamp}`);
  await IOUtils.makeDirectory(workspaceDir, { ignoreExisting: true });

  const pdfBasename = "paper.pdf";
  const pdfPath = PathUtils.join(workspaceDir, pdfBasename);
  await IOUtils.write(pdfPath, bytes);

  const cleanup = async () => {
    try {
      await IOUtils.remove(workspaceDir, {
        recursive: true,
        ignoreAbsent: true,
      });
    } catch (e) {
      try {
        ztoolkit.log(
          "[CursorAgentProvider] 清理 PDF 临时目录失败:",
          workspaceDir,
          e,
        );
      } catch {
        /* ignore */
      }
    }
  };

  return { pdfPath, pdfBasename, workspaceDir, cleanup };
}

/**
 * 构造 cursor-agent 子进程使用的 CLI 参数（不含最后的 prompt 串）。
 * 与 CursorAgentProvider#buildCliArgs 保持一致，提到模块顶层后既被类内部使用，
 * 也供单元测试直接断言 argv 形状。
 *
 * 新版 cursor-agent CLI（≥ 2026.06）将 `--mode` 的合法值收窄为 `plan` / `ask`，
 * `agent` 模式不再通过 `--mode` 传递——**省略 `--mode`** 即默认 agent 模式。
 * 我们插件里仍保留 `agent` 作为内部抽象的"运行模式"枚举值，但在 argv 层把它
 * 翻译为"不发 `--mode`，同时附加 `-f` 让工具执行不必交互确认"。
 */
export function buildCursorAgentArgs(
  options: LLMOptions,
  overrides: { forceMode?: CursorRunMode; resumeSessionId?: string } = {},
): string[] {
  const vendor = options.vendorOptions || {};
  const mode = overrides.forceMode ?? normalizeRunMode(vendor.cursorAgentMode);
  const extraArgs = splitExtraArgs(String(vendor.cursorAgentExtraArgs || ""));
  const model = String(options.model || "").trim();
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
  ];
  // agent 模式：省略 --mode（CLI 默认即 agent）。其余两种模式才显式注入。
  if (mode === "ask" || mode === "plan") args.push("--mode", mode);
  if (model) args.push("--model", model);
  // -f：让 agent 模式下的命令/工具调用免交互批准；plan / ask 是只读，不需要也无害
  if (mode === "agent") args.push("-f");
  const workspace = String(vendor.cursorAgentWorkspace || "").trim();
  if (workspace) args.push("--workspace", workspace);
  const resumeId = String(overrides.resumeSessionId || "").trim();
  if (resumeId) args.push("--resume", resumeId);
  for (const arg of extraArgs) args.push(arg);
  return args;
}

interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  result?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  session_id?: string;
  model?: string;
  apiKeySource?: string;
  is_error?: boolean;
  duration_ms?: number;
}

interface CursorRunResult {
  /** 流式过程中累积的文本（仅 delta 事件）。 */
  streamedText: string;
  /** 最终 `result` 事件给出的权威答案。 */
  canonicalResult: string;
  /** 最终事件原始 JSON，便于上层调试。 */
  finalEvent: CursorStreamEvent | null;
  /** init 事件携带的元数据。 */
  init: CursorStreamEvent | null;
  /** stderr 末尾若干字节，错误诊断用。 */
  stderrTail: string;
  /** 进程退出码。 */
  exitCode: number;
}

export interface CursorStreamState {
  streamedText: string;
  canonicalResult: string;
  finalEvent: CursorStreamEvent | null;
  initEvent: CursorStreamEvent | null;
}

/** 创建空的流解析状态。 */
export function createCursorStreamState(): CursorStreamState {
  return {
    streamedText: "",
    canonicalResult: "",
    finalEvent: null,
    initEvent: null,
  };
}

/**
 * 把一行 NDJSON 应用到流解析状态。
 *
 * 返回:
 *   - `delta`: 本次新追加的文本（增量），可空字符串
 *   - `parseFailed`: 该行不是合法 JSON 时为 true（调用者通常应忽略）
 *
 * 该函数是纯函数（除会写入 state），便于单元测试 NDJSON 解析逻辑而不需要
 * 真正启动子进程。
 */
export function applyCursorStreamLine(
  state: CursorStreamState,
  rawLine: string,
): { delta: string; parseFailed: boolean } {
  const line = rawLine.replace(/\r$/, "");
  if (!line.trim()) return { delta: "", parseFailed: false };

  let event: CursorStreamEvent | null = null;
  try {
    event = JSON.parse(line) as CursorStreamEvent;
  } catch {
    return { delta: "", parseFailed: true };
  }
  if (!event || typeof event !== "object") {
    return { delta: "", parseFailed: false };
  }

  if (event.type === "system" && event.subtype === "init") {
    state.initEvent = event;
    return { delta: "", parseFailed: false };
  }

  if (event.type === "assistant") {
    const isDelta =
      typeof event.timestamp_ms === "number" &&
      event.timestamp_ms > 0 &&
      !event.model_call_id;
    if (!isDelta) return { delta: "", parseFailed: false };
    const parts = event.message?.content || [];
    let delta = "";
    for (const part of parts) {
      if (part?.type === "text" && typeof part.text === "string") {
        delta += part.text;
      }
    }
    state.streamedText += delta;
    return { delta, parseFailed: false };
  }

  if (event.type === "result") {
    state.finalEvent = event;
    if (typeof event.result === "string") {
      state.canonicalResult = event.result;
    }
    return { delta: "", parseFailed: false };
  }

  if (event.type === "error" || event.is_error === true) {
    state.finalEvent = event;
  }
  return { delta: "", parseFailed: false };
}

/**
 * 简单的有界 LRU 容器：超过容量时淘汰最旧的条目。
 * 用于 CursorAgentProvider 缓存"会话前缀 → sessionId"映射。导出仅供单元测试。
 */
export class BoundedLruMap<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly capacity: number) {}
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  /** 仅供单元测试观察当前缓存大小。 */
  get size(): number {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
}

/**
 * 为一段 conversation 计算稳定指纹，作为 sessionId 缓存的 key 一部分。
 * 仅使用 role + content 文本，不引入哈希依赖。导出仅供单元测试。
 */
export function fingerprintConversation(
  messages: ConversationMessage[],
): string {
  // 用 \u0001 / \u0002 这些极少出现的控制字符做分隔，规避 content 内出现冲突
  return messages
    .map((m) => `${m.role}\u0001${m.content || ""}`)
    .join("\u0002");
}

/** 把 endpoint 关键参数合成一个 key，避免不同账号 / 模型间串 sessionId。导出仅供单元测试。 */
export function endpointKeyOf(options: LLMOptions): string {
  return [
    String(options.apiUrl || ""),
    String(options.apiKey || ""),
    String(options.model || ""),
  ].join("|");
}

export class CursorAgentProvider implements ILlmProvider {
  readonly id = "cursor-agent";
  readonly capabilities: LLMProviderCapabilities = {
    supportsText: true,
    supportsStreaming: true,
    // 通过 prepareBase64PdfWorkspace 把 PDF 写到一个隔离的临时目录，再以
    // agent 模式 + --workspace 让 cursor-agent 自己读取，不再原地拒收 base64。
    supportsPdfBase64: true,
    maxPdfFiles: 1,
    supportsSystemPrompt: true,
    supportedParams: ["stream", "reasoningEffort"],
  };

  /**
   * 进程内缓存：endpointKey + 会话前缀指纹 → cursor-agent 上次返回的 session_id。
   * 仅用于 chat() 路径；每次成功响应后写入，下一轮命中"完整匹配的前缀"时改走 --resume。
   * 容量上限 32，淘汰策略 LRU；插件重启即丢，不持久化。
   */
  private resumeCache = new BoundedLruMap<string, string>(32);

  // ============================================================
  // ILlmProvider 接口实现
  // ============================================================

  async generateSummary(
    content: string,
    isBase64: boolean,
    prompt: string | undefined,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    throwIfAborted(options.abortSignal);

    if (isBase64) {
      // ============ Base64 PDF 直传：写到临时目录，切到 agent 模式 ============
      const ws = await prepareBase64PdfWorkspace(content);
      try {
        const userMessage = buildUserMessage(
          prompt || "",
          `（论文 PDF 已放在本会话的工作目录里：./${ws.pdfBasename}，详见下方说明）`,
        );
        const combinedPrompt = this.composePdfFileReadingPrompt(
          userMessage,
          ws.pdfBasename,
        );
        const runOptions = this.deriveOptionsForPdfFile(
          options,
          ws.workspaceDir,
        );
        const result = await this.runAgent(
          combinedPrompt,
          runOptions,
          onProgress,
        );
        return result.canonicalResult || result.streamedText;
      } finally {
        await ws.cleanup();
      }
    }

    // ============ 文本模式 ============
    const userMessage = buildUserMessage(prompt || "", content);
    const combinedPrompt = this.composeFinalPrompt(userMessage);
    const result = await this.runAgent(combinedPrompt, options, onProgress);
    return result.canonicalResult || result.streamedText;
  }

  async chat(
    pdfContent: string,
    isBase64: boolean,
    conversation: ConversationMessage[],
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    throwIfAborted(options.abortSignal);

    if (isBase64) {
      // ============ Base64 PDF 直传：多轮会话仍走"文件 + 拍扁会话历史"路线 ============
      // 续聊不可用：每次生成的临时 workspace 不同，server 端无对应 PDF 上下文，
      // 强行 --resume 反而会让模型答非所问。base64 路径整体不走 sessionId 缓存。
      const ws = await prepareBase64PdfWorkspace(pdfContent);
      try {
        const segments = this.flattenConversation(
          conversation,
          `（论文 PDF 已放在本会话的工作目录里：./${ws.pdfBasename}，详见下方说明）`,
        );
        const combinedPrompt = this.composePdfFileReadingPrompt(
          segments,
          ws.pdfBasename,
        );
        const runOptions = this.deriveOptionsForPdfFile(
          options,
          ws.workspaceDir,
        );
        const result = await this.runAgent(
          combinedPrompt,
          runOptions,
          onProgress,
        );
        return result.canonicalResult || result.streamedText;
      } finally {
        await ws.cleanup();
      }
    }

    // ============ 文本模式：尝试用 --resume 续聊 ============
    const resumeId = this.lookupResumeSessionId(conversation, options);
    if (resumeId) {
      try {
        const result = await this.runAgent(
          this.lastUserMessageOnly(conversation, pdfContent),
          options,
          onProgress,
          undefined,
          { resumeSessionId: resumeId },
        );
        this.captureSessionFromResult(conversation, options, result);
        return result.canonicalResult || result.streamedText;
      } catch (e: any) {
        // 续聊失败（最常见原因：server 端会话已 GC 或 sessionId 失效）→ 清缓存并降级到全量重发
        this.evictResumeEntry(conversation, options);
        try {
          ztoolkit.log(
            "[CursorAgentProvider] --resume 失败，回退到完整 conversation 重发:",
            e?.message || e,
          );
        } catch {
          /* ignore */
        }
        // 不向上抛错，继续走全量 flatten 路径
      }
    }

    // ============ 全量 conversation 拍扁（首轮 / 无命中 / 续聊失败回退） ============
    const segments = this.flattenConversation(conversation, pdfContent);
    const combinedPrompt = this.composeFinalPrompt(segments);
    const result = await this.runAgent(combinedPrompt, options, onProgress);
    this.captureSessionFromResult(conversation, options, result);
    return result.canonicalResult || result.streamedText;
  }

  // ============================================================
  // sessionId 续聊 helper
  // ============================================================

  /**
   * 判断当前 conversation 是否能复用一个已知 sessionId：
   *   - 用户明确关闭了 resume 开关 → 返回 null
   *   - 末尾不是 user 消息 → 没法只发一条新 user 消息，返回 null
   *   - 历史长度 < 2（首轮）→ 没东西可续，返回 null
   *   - 否则用 conversation.slice(0, -1) 的指纹查缓存
   */
  private lookupResumeSessionId(
    conversation: ConversationMessage[],
    options: LLMOptions,
  ): string | null {
    const vendor = options.vendorOptions || {};
    if (vendor.cursorAgentResumeEnabled === false) return null;
    if (!Array.isArray(conversation) || conversation.length < 2) return null;
    const last = conversation[conversation.length - 1];
    if (!last || last.role !== "user") return null;
    const prefix = conversation.slice(0, -1);
    const key = `${endpointKeyOf(options)}::${fingerprintConversation(prefix)}`;
    return this.resumeCache.get(key) ?? null;
  }

  /**
   * 调用成功后，把"整段 conversation 指纹"映射到本次返回的 session_id。
   * 这样下一轮 conversation = [...这一段, newUser] 时，前缀指纹就能命中。
   */
  private captureSessionFromResult(
    conversation: ConversationMessage[],
    options: LLMOptions,
    result: CursorRunResult,
  ) {
    const sid = String(result.init?.session_id || "").trim();
    if (!sid) return;
    if (!Array.isArray(conversation) || conversation.length === 0) return;
    const key = `${endpointKeyOf(options)}::${fingerprintConversation(conversation)}`;
    this.resumeCache.set(key, sid);
  }

  /** 续聊失败时清掉对应 prefix 的缓存条目，避免下次又选中它。 */
  private evictResumeEntry(
    conversation: ConversationMessage[],
    options: LLMOptions,
  ) {
    if (!Array.isArray(conversation) || conversation.length < 2) return;
    const prefix = conversation.slice(0, -1);
    const key = `${endpointKeyOf(options)}::${fingerprintConversation(prefix)}`;
    (this.resumeCache as any).map?.delete(key);
  }

  /** 续聊模式下只把最新一条 user 消息（必要时拼接 PDF 文本）作为 prompt 发出去。 */
  private lastUserMessageOnly(
    conversation: ConversationMessage[],
    pdfContent: string,
  ): string {
    const last = conversation[conversation.length - 1];
    const userText = last?.content || "";
    // PDF 文本在首轮已经发过，这里再带一份是冗余但安全；模型只需 incremental 回答最新一条
    return this.composeFinalPrompt(buildUserMessage(userText, pdfContent));
  }

  /** 仅供单元测试观察续聊缓存状态。 */
  public _peekResumeCacheSize(): number {
    return this.resumeCache.size;
  }
  /** 仅供单元测试清空续聊缓存。 */
  public _clearResumeCache(): void {
    this.resumeCache.clear();
  }

  /**
   * 把多轮 conversation 拍扁成一段以 `### 用户 / ### 助手` 分隔的 markdown，
   * 并把 PDF 文本拼到首条 user 消息后（保留原有行为）。
   * 抽出独立方法以便文本与 base64 两条路径复用。
   */
  private flattenConversation(
    conversation: ConversationMessage[],
    pdfPayload: string,
  ): string {
    const segments: string[] = [];
    let appendedPdf = false;
    for (const msg of conversation) {
      const role = msg.role === "assistant" ? "助手" : "用户";
      let text = msg.content || "";
      if (!appendedPdf && msg.role === "user") {
        text = buildUserMessage(text, pdfPayload);
        appendedPdf = true;
      }
      segments.push(`### ${role}\n${text}`);
    }
    if (!appendedPdf) {
      segments.push(`### 用户\n${buildUserMessage("", pdfPayload)}`);
    }
    return segments.join("\n\n");
  }

  async testConnection(options: LLMOptions): Promise<string> {
    const probe = `${CONNECTION_TEST_TEXT}\n\n(此请求由 AI 管家连接测试发起)`;
    const overriddenOptions: LLMOptions = {
      ...options,
      stream: false,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
    };
    const args = this.buildArgsForTest(overriddenOptions);
    const binaryPath = this.resolveAgentBinary(options);

    let runResult: CursorRunResult;
    try {
      runResult = await this.runAgent(probe, overriddenOptions);
    } catch (error: any) {
      // runAgent 内部统一把 stderr 拼到 message，这里包装成 APITestError
      const stderrTail = String(error?.stderrTail || "").slice(-2048);
      const requestBody = args.join(" ");
      throw new APITestError(error?.message || "Cursor Agent 测试失败", {
        errorName: error?.name || "CursorAgentError",
        errorMessage: error?.message || String(error),
        requestUrl: binaryPath || "(未配置 agent 可执行文件路径)",
        requestBody,
        responseBody: stderrTail || undefined,
      });
    }

    const answer = runResult.canonicalResult || runResult.streamedText;
    const lines = [
      `Mode: ${getConnectionTestModeLabel("text")}`,
      "✅ Cursor Agent 连接成功",
      `可执行文件: ${binaryPath}`,
    ];
    if (runResult.init?.model) lines.push(`模型: ${runResult.init.model}`);
    if (runResult.init?.apiKeySource) {
      lines.push(`凭据来源: ${runResult.init.apiKeySource}`);
    }
    if (runResult.init?.session_id) {
      lines.push(`Session: ${runResult.init.session_id}`);
    }
    lines.push("", "--- 模型回复 ---", answer || "(空响应)");
    if (runResult.stderrTail.trim()) {
      lines.push("", "--- stderr 末尾 ---", runResult.stderrTail.slice(-512));
    }
    return lines.join("\n");
  }

  async listModels(options: LLMOptions): Promise<LLMModelInfo[]> {
    const binary = this.resolveAgentBinary(options);
    const env = this.buildEnv(options);
    const spec = await resolveCursorLaunchSpec(
      binary,
      env,
      isWindowsPlatform(),
    );
    const Subprocess = loadSubprocessModule();
    if (!Subprocess) {
      throw new Error(
        "无法加载 Mozilla Subprocess 模块，Cursor Agent provider 当前环境不支持。",
      );
    }
    const proc = await Subprocess.call({
      command: spec.command,
      arguments: [...spec.prefixArgs, "models"],
      environment: env,
      stderr: "pipe",
    });
    const stdoutText = await this.drainAll(proc.stdout);
    const stderrText = await this.drainAll(proc.stderr);
    const { exitCode } = await proc.wait();
    if (exitCode !== 0) {
      throw new Error(
        `agent models 退出码 ${exitCode}: ${stderrText.slice(-512) || stdoutText.slice(-512)}`,
      );
    }
    // `agent models` 输出按行的模型 ID 列表（首列即 ID，可能跟描述）
    const seen = new Set<string>();
    const result: LLMModelInfo[] = [];
    for (const raw of stdoutText.split(/\r?\n/)) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // 简单 tokenize：第一段视为 id，剩下作为描述
      const parts = trimmed.split(/\s{2,}|\t+/);
      const id = (parts[0] || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        name: id,
        description: parts.slice(1).join(" ").trim() || undefined,
      });
    }
    return result;
  }

  // ============================================================
  // 内部 helper
  // ============================================================

  private composeFinalPrompt(userBody: string): string {
    // Cursor CLI 没有 system / user 分离，这里把 system 角色作为 prompt 前缀注入。
    return `[System]\n${SYSTEM_ROLE_PROMPT}\n\n[User]\n${userBody}`;
  }

  /**
   * PDF 文件直传模式专用 prompt：
   * 提示 cursor-agent 工作目录里有一份 PDF，需要它用文件读取工具读出来再回答。
   */
  private composePdfFileReadingPrompt(
    userBody: string,
    pdfBasename: string,
  ): string {
    const path = `./${pdfBasename}`;
    return [
      "[System]",
      SYSTEM_ROLE_PROMPT,
      "",
      "[Workspace Notes]",
      `本次会话的工作目录里只放了一个论文 PDF 文件：${path}`,
      `请使用 cursor-agent 的内置文件工具读取该 PDF 的全部内容，然后基于读到的论文原文回答下方的用户请求。`,
      `若调用 read_file 时返回的是二进制乱码，可改用 cursor 自带的 PDF / 文档读取工具；`,
      `若所有读取工具都不可用，请明确告知用户："当前模型在 Cursor Agent 模式下读不到 PDF，请把该模型的 PDF 处理方式改成‘文本提取’或‘MinerU’。"，不要伪造论文内容。`,
      "",
      "[User]",
      userBody,
    ].join("\n");
  }

  /**
   * 为 PDF 文件直传模式派生一份 LLMOptions：
   *   - 强制 mode=agent（必须开启工具调用才能读 PDF）
   *   - 覆盖 workspace 指向临时目录（用户原本设置的 workspace 不适用于本次调用）
   * 不修改原 options 对象。
   */
  private deriveOptionsForPdfFile(
    options: LLMOptions,
    workspaceDir: string,
  ): LLMOptions {
    return {
      ...options,
      vendorOptions: {
        ...(options.vendorOptions || {}),
        cursorAgentMode: "agent",
        cursorAgentWorkspace: workspaceDir,
      },
    };
  }

  /**
   * 解析最终要传给 Subprocess 的 agent 可执行文件路径。
   *
   * 优先级：
   *   1. 用户在 endpoint 里显式填写的绝对路径
   *   2. 平台对应的若干常见安装位置（IOUtils.existsSync 真实存在的那一个）
   *   3. 裸文件名 `agent.exe` / `agent` —— 让 Mozilla Subprocess 自己沿 PATH 搜
   *      （cursor 官方安装脚本会把对应目录加到 PATH，绝大多数情况这一步能命中）
   */
  private resolveAgentBinary(options: LLMOptions): string {
    const explicit = String(options.apiUrl || "").trim();
    if (explicit) return explicit;
    const env = readProcessEnv();
    const isWin = isWindowsPlatform();
    const candidates = isWin
      ? DEFAULT_AGENT_PATHS_WIN
      : DEFAULT_AGENT_PATHS_UNIX;
    const IOUtils = (globalThis as any).IOUtils;
    for (const tpl of candidates) {
      const resolved = expandEnv(tpl, env);
      if (!resolved) continue;
      // 模板里有未解析变量（例如 ${ProgramFiles} 在某些精简 Windows 上不存在）
      // → 跳过，免得 IOUtils 收到含 `${` 的非法路径
      if (resolved.includes("${")) continue;
      try {
        if (IOUtils?.existsSync) {
          if (IOUtils.existsSync(resolved)) return resolved;
        }
      } catch {
        /* fallthrough */
      }
    }
    // 都没找到 → 返回裸文件名，让 Subprocess 沿 PATH 搜索（cursor 装好后通常在 PATH 里）
    return isWin ? "agent.exe" : "agent";
  }

  /** 构建子进程使用的环境变量：继承父进程 PATH/HOME + 注入 CURSOR_API_KEY。 */
  private buildEnv(options: LLMOptions): Record<string, string> {
    const env: Record<string, string> = { ...readProcessEnv() };
    const apiKey = String(options.apiKey || "").trim();
    if (apiKey) env.CURSOR_API_KEY = apiKey;
    return env;
  }

  private buildArgsForTest(options: LLMOptions): string[] {
    return buildCursorAgentArgs(options, { forceMode: "ask" });
  }

  private buildCliArgs(
    options: LLMOptions,
    overrides: { forceMode?: CursorRunMode; resumeSessionId?: string } = {},
  ): string[] {
    return buildCursorAgentArgs(options, overrides);
  }

  /**
   * 启动 cursor-agent 子进程，并解析 NDJSON 流。
   *
   * `subprocessOverride` 仅用于单元测试注入 mock subprocess；生产代码不会传入。
   * `extraArgsOverrides` 透传给 buildCliArgs，目前用于 --resume <session_id>。
   */
  protected async runAgent(
    prompt: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
    subprocessOverride?: SubprocessModule,
    extraArgsOverrides: { resumeSessionId?: string } = {},
  ): Promise<CursorRunResult> {
    const Subprocess = subprocessOverride ?? loadSubprocessModule();
    if (!Subprocess) {
      throw new Error(
        "无法加载 Mozilla Subprocess 模块，Cursor Agent provider 当前环境不支持。请确认运行在 Zotero 7+。",
      );
    }
    const binary = this.resolveAgentBinary(options);
    if (!binary) {
      throw new Error(
        "未找到 cursor-agent 可执行文件，请在 API 配置中填写其绝对路径（例如 ~/.local/bin/agent）。",
      );
    }
    const env = this.buildEnv(options);
    const spec = await resolveCursorLaunchSpec(
      binary,
      env,
      isWindowsPlatform(),
    );
    const userArgs = this.buildCliArgs(options, extraArgsOverrides);
    const args = [...spec.prefixArgs, ...userArgs];
    const timeoutMs = options.requestTimeoutMs ?? getRequestTimeoutMs();

    ztoolkit.log(
      `[CursorAgentProvider] spawn: ${spec.command} ${args.join(
        " ",
      )} <stdin prompt ${prompt.length} chars> (display=${spec.display}, embeddedNode=${spec.viaEmbeddedNode})`,
    );

    let proc: SubprocessProcess;
    try {
      proc = await Subprocess.call({
        command: spec.command,
        arguments: args,
        environment: env,
        environmentAppend: false,
        stderr: "pipe",
      });
    } catch (error: any) {
      throw new Error(
        `启动 cursor-agent 子进程失败：${error?.message || error} (command=${spec.command}, originalBinary=${binary})`,
      );
    }

    try {
      if (!proc.stdin?.write || !proc.stdin?.close) {
        throw new Error("当前 Subprocess stdin 不支持 write/close");
      }
      // Do not pass the prompt as an argv element. On Windows, multiline argv
      // values are truncated by the Cursor Agent launch chain to the first line
      // (often just "[System]"). cursor-agent -p reads stdin correctly.
      await proc.stdin.write(prompt);
      await proc.stdin.close();
    } catch (error: any) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      throw new Error(
        `写入 cursor-agent prompt 失败：${error?.message || error} (command=${spec.command}, originalBinary=${binary})`,
      );
    }

    const stderrChunks: string[] = [];
    let stderrLength = 0;
    const STDERR_BUDGET = 8192;

    const stderrTask = (async () => {
      while (true) {
        const chunk = await proc.stderr.readString().catch(() => null);
        if (!chunk) break;
        stderrChunks.push(chunk);
        stderrLength += chunk.length;
        if (stderrLength > STDERR_BUDGET * 2) {
          // 保留尾部，避免长进程把 stderr 撑大
          const joined = stderrChunks.join("");
          stderrChunks.length = 0;
          stderrChunks.push(joined.slice(-STDERR_BUDGET));
          stderrLength = stderrChunks[0].length;
        }
      }
    })();

    const streamState = createCursorStreamState();
    let abortError: LLMRequestAbortError | null = null;
    let abortCleanup: (() => void) | undefined;

    if (options.abortSignal) {
      const abort = () => {
        abortError = createAbortError(options.abortSignal);
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      };
      if (options.abortSignal.aborted) abort();
      options.abortSignal.addEventListener?.("abort", abort, { once: true });
      abortCleanup = () =>
        options.abortSignal?.removeEventListener?.("abort", abort);
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const stdoutTask = (async () => {
      let buffer = "";
      while (true) {
        const chunk = await proc.stdout.readString().catch(() => null);
        if (!chunk) break;
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const { delta } = applyCursorStreamLine(streamState, line);
          if (delta && onProgress) {
            try {
              await onProgress(delta);
            } catch (err) {
              ztoolkit.log("[CursorAgentProvider] onProgress error:", err);
            }
          }
        }
      }
    })();

    const waitPromise = proc.wait();
    const race = await Promise.race([
      Promise.all([stdoutTask, stderrTask, waitPromise]).then(
        () => "done" as const,
      ),
      timeoutPromise,
    ]);

    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    abortCleanup?.();

    if (race === "timeout") {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      const stderrTail = stderrChunks.join("").slice(-STDERR_BUDGET);
      const err = new Error(
        `Cursor Agent 执行超时（>${timeoutMs}ms）。${stderrTail.slice(-512)}`,
      );
      (err as any).stderrTail = stderrTail;
      throw err;
    }

    let exitCode = 0;
    try {
      const waited = await waitPromise;
      exitCode = waited.exitCode;
    } catch {
      /* already resolved or killed */
    }

    if (abortError) {
      throw normalizeAbortError(abortError, options.abortSignal);
    }

    const stderrTail = stderrChunks.join("").slice(-STDERR_BUDGET);

    if (
      exitCode !== 0 &&
      !streamState.canonicalResult &&
      !streamState.streamedText
    ) {
      const err = new Error(
        `Cursor Agent 退出码 ${exitCode}。${stderrTail.slice(-512) || "(无 stderr 输出)"}`,
      );
      (err as any).stderrTail = stderrTail;
      throw err;
    }

    const fe = streamState.finalEvent;
    if (
      fe?.type === "error" ||
      fe?.subtype === "error" ||
      fe?.is_error === true
    ) {
      const err = new Error(
        `Cursor Agent 返回 error 事件：${JSON.stringify(fe)}`,
      );
      (err as any).stderrTail = stderrTail;
      if (!streamState.canonicalResult && !streamState.streamedText) throw err;
    }

    return {
      streamedText: streamState.streamedText,
      canonicalResult: streamState.canonicalResult,
      finalEvent: streamState.finalEvent,
      init: streamState.initEvent,
      stderrTail,
      exitCode,
    };
  }

  /**
   * 仅供单元测试使用的 thin wrapper：暴露 protected runAgent，并强制注入 mock subprocess。
   * 不在生产代码中调用。
   */
  public async _runAgentForTest(
    prompt: string,
    options: LLMOptions,
    subprocess: SubprocessModule,
    onProgress?: ProgressCb,
  ): Promise<CursorRunResult> {
    return this.runAgent(prompt, options, onProgress, subprocess);
  }

  /** 把一个 Subprocess 管道全部读出来（用于一次性命令，例如 `agent models`）。 */
  private async drainAll(pipe: SubprocessPipe): Promise<string> {
    const parts: string[] = [];
    while (true) {
      const chunk = await pipe.readString().catch(() => null);
      if (!chunk) break;
      parts.push(chunk);
    }
    return parts.join("");
  }
}

// 自注册到 Provider 注册表
import { ProviderRegistry } from "./ProviderRegistry";
ProviderRegistry.register(new CursorAgentProvider());

export default CursorAgentProvider;
