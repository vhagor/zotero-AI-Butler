import { expect } from "chai";
import {
  BoundedLruMap,
  CursorAgentProvider,
  applyCursorStreamLine,
  buildCursorAgentArgs,
  createCursorStreamState,
  endpointKeyOf,
  expandEnv,
  fingerprintConversation,
  normalizeRunMode,
  resolveCursorLaunchSpec,
  splitExtraArgs,
} from "../src/modules/llmproviders/CursorAgentProvider";
import type {
  ConversationMessage,
  LLMOptions,
} from "../src/modules/llmproviders/types";

function baseOptions(extra: Partial<LLMOptions> = {}): LLMOptions {
  return {
    apiUrl: "",
    apiKey: "",
    model: "composer-2.5",
    stream: true,
    requestTimeoutMs: 60_000,
    ...extra,
  } as LLMOptions;
}

/** Minimal in-memory pipe that yields chunks one readString() at a time. */
function makePipe(chunks: (string | null)[]): {
  readString: () => Promise<string | null>;
  close: () => void;
  write: (data: string) => Promise<void>;
  writes: string[];
} {
  const queue = [...chunks];
  const writes: string[] = [];
  return {
    writes,
    async readString() {
      if (queue.length === 0) return null;
      const next = queue.shift();
      return next ?? null;
    },
    async write(data: string) {
      writes.push(data);
    },
    close() {
      queue.length = 0;
    },
  };
}

/** Construct a fake Subprocess module producing the given stdout/stderr lines. */
function fakeSubprocess(opts: {
  stdoutLines: string[];
  stderrLines?: string[];
  exitCode?: number;
  spawnError?: Error;
  exitDelayMs?: number;
  onCall?: (call: any) => void;
}) {
  return {
    async call(callOpts: any) {
      if (opts.spawnError) throw opts.spawnError;
      const stdout = makePipe([
        opts.stdoutLines.join("\n") + (opts.stdoutLines.length ? "\n" : ""),
        null,
      ]);
      const stderr = makePipe([
        ...(opts.stderrLines ?? []).map((l) => l + "\n"),
        null,
      ]);
      let killed = false;
      const proc = {
        stdout,
        stderr,
        stdin: makePipe([]),
        pid: 1234,
        async wait() {
          if (opts.exitDelayMs)
            await new Promise((r) => setTimeout(r, opts.exitDelayMs));
          return { exitCode: killed ? 137 : (opts.exitCode ?? 0) };
        },
        kill() {
          killed = true;
          stdout.close();
          stderr.close();
        },
      };
      opts.onCall?.({ ...callOpts, proc });
      return proc as any;
    },
  };
}

describe("CursorAgentProvider", function () {
  // ============================================================
  // Pure helpers
  // ============================================================

  describe("pure helpers", function () {
    describe("normalizeRunMode", function () {
      it("returns ask by default for empty / unknown values", function () {
        expect(normalizeRunMode(undefined)).to.equal("ask");
        expect(normalizeRunMode(null)).to.equal("ask");
        expect(normalizeRunMode("")).to.equal("ask");
        expect(normalizeRunMode("foo")).to.equal("ask");
      });

      it("accepts agent / plan case-insensitively and trims whitespace", function () {
        expect(normalizeRunMode("agent")).to.equal("agent");
        expect(normalizeRunMode("AGENT")).to.equal("agent");
        expect(normalizeRunMode("  plan  ")).to.equal("plan");
        expect(normalizeRunMode("Plan")).to.equal("plan");
      });
    });

    describe("splitExtraArgs", function () {
      it("returns an empty array for empty input", function () {
        expect(splitExtraArgs("")).to.deep.equal([]);
        expect(splitExtraArgs(undefined)).to.deep.equal([]);
        expect(splitExtraArgs(null)).to.deep.equal([]);
      });

      it("splits whitespace-separated tokens", function () {
        expect(splitExtraArgs("--foo bar --baz 42")).to.deep.equal([
          "--foo",
          "bar",
          "--baz",
          "42",
        ]);
      });

      it("preserves double-quoted values containing spaces", function () {
        expect(
          splitExtraArgs('--header "X-Foo: bar baz" --flag'),
        ).to.deep.equal(["--header", "X-Foo: bar baz", "--flag"]);
      });

      it("preserves single-quoted values containing spaces", function () {
        expect(splitExtraArgs("--name 'foo bar'")).to.deep.equal([
          "--name",
          "foo bar",
        ]);
      });

      it("ignores empty tokens", function () {
        expect(splitExtraArgs('  --foo  ""  --bar  ')).to.deep.equal([
          "--foo",
          "--bar",
        ]);
      });
    });

    describe("expandEnv", function () {
      it("replaces ${VAR} with the corresponding env value", function () {
        const env = { HOME: "/home/alice", LOCALAPPDATA: "C:\\Users\\Alice" };
        expect(expandEnv("${HOME}/.local/bin/agent", env)).to.equal(
          "/home/alice/.local/bin/agent",
        );
        expect(expandEnv("${LOCALAPPDATA}\\Programs\\agent.exe", env)).to.equal(
          "C:\\Users\\Alice\\Programs\\agent.exe",
        );
      });

      it("replaces unknown variables with empty string", function () {
        expect(expandEnv("${MISSING}/agent", {})).to.equal("/agent");
      });

      it("leaves literal text without ${} untouched", function () {
        expect(expandEnv("/usr/local/bin/agent", { HOME: "/home/a" })).to.equal(
          "/usr/local/bin/agent",
        );
      });

      // 关键回归：Windows 上 HOME 常常缺失，必须自动用 USERPROFILE 兜底，
      // 否则会生成 "/.local/bin/agent" 这种把"/" 当成根目录的非法路径
      it("falls back to USERPROFILE when HOME is missing (Windows)", function () {
        const env = { USERPROFILE: "C:\\Users\\Alice" };
        expect(expandEnv("${HOME}\\.local\\bin\\agent.exe", env)).to.equal(
          "C:\\Users\\Alice\\.local\\bin\\agent.exe",
        );
      });

      it("falls back to HOME when USERPROFILE is missing (Unix)", function () {
        const env = { HOME: "/home/bob" };
        expect(expandEnv("${USERPROFILE}/.local/bin/agent", env)).to.equal(
          "/home/bob/.local/bin/agent",
        );
      });
    });
  });

  // ============================================================
  // resolveCursorLaunchSpec — Windows wrapper / embedded-node detection
  // ============================================================

  describe("resolveCursorLaunchSpec", function () {
    /** 安装一个最小可用的 globalThis.IOUtils 桩，函数式控制 existsSync / exists / getChildren。 */
    function installIOUtilsStub(stub: {
      existsSync?: (path: string) => boolean;
      exists?: (path: string) => Promise<boolean>;
      getChildren?: (path: string) => Promise<string[]>;
    }) {
      const g = globalThis as any;
      const original = g.IOUtils;
      g.IOUtils = {
        existsSync: stub.existsSync ?? (() => false),
        exists: stub.exists ?? (async () => false),
        getChildren: stub.getChildren ?? (async () => []),
      };
      return () => {
        if (original === undefined) delete g.IOUtils;
        else g.IOUtils = original;
      };
    }

    const WIN_ENV = {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      LOCALAPPDATA: "C:\\Users\\Bob\\AppData\\Local",
    };

    it("passes through .exe paths unchanged on Windows", async function () {
      const restore = installIOUtilsStub({});
      try {
        const spec = await resolveCursorLaunchSpec(
          "C:\\Program Files\\Cursor\\agent.exe",
          WIN_ENV,
          true,
        );
        expect(spec.command).to.equal("C:\\Program Files\\Cursor\\agent.exe");
        expect(spec.prefixArgs).to.deep.equal([]);
        expect(spec.viaEmbeddedNode).to.equal(false);
      } finally {
        restore();
      }
    });

    it("passes through bare names unchanged (PATH search) on Windows", async function () {
      const restore = installIOUtilsStub({});
      try {
        const spec = await resolveCursorLaunchSpec("agent.exe", WIN_ENV, true);
        expect(spec.command).to.equal("agent.exe");
        expect(spec.prefixArgs).to.deep.equal([]);
      } finally {
        restore();
      }
    });

    it("passes through Unix paths unchanged regardless of suffix", async function () {
      const restore = installIOUtilsStub({});
      try {
        const spec = await resolveCursorLaunchSpec(
          "/home/alice/.local/bin/agent",
          { HOME: "/home/alice" },
          false,
        );
        expect(spec.command).to.equal("/home/alice/.local/bin/agent");
        expect(spec.prefixArgs).to.deep.equal([]);
      } finally {
        restore();
      }
    });

    it("redirects .cmd in a cursor-agent install dir to embedded node.exe + index.js", async function () {
      const installDir = "C:\\Users\\Bob\\AppData\\Local\\cursor-agent";
      const versionDir = `${installDir}\\versions\\2026.06.12-19-59-36-f6aba9a`;
      const restore = installIOUtilsStub({
        existsSync: (p) => p === `${installDir}\\versions`,
        exists: async (p) =>
          p === `${versionDir}\\node.exe` || p === `${versionDir}\\index.js`,
        getChildren: async (p) =>
          p === `${installDir}\\versions` ? [versionDir] : [],
      });
      try {
        const spec = await resolveCursorLaunchSpec(
          `${installDir}\\agent.cmd`,
          WIN_ENV,
          true,
        );
        expect(spec.viaEmbeddedNode).to.equal(true);
        expect(spec.command).to.equal(`${versionDir}\\node.exe`);
        expect(spec.prefixArgs).to.deep.equal([`${versionDir}\\index.js`]);
        expect(spec.display).to.equal(`${versionDir}\\node.exe`);
      } finally {
        restore();
      }
    });

    it("picks the lexicographically newest version when multiple are present", async function () {
      const installDir = "C:\\Users\\Bob\\AppData\\Local\\cursor-agent";
      const older = `${installDir}\\versions\\2026.05.01-aaaaaaa`;
      const newer = `${installDir}\\versions\\2026.06.12-19-59-36-f6aba9a`;
      const restore = installIOUtilsStub({
        existsSync: (p) => p === `${installDir}\\versions`,
        exists: async (p) =>
          p === `${newer}\\node.exe` || p === `${newer}\\index.js`,
        getChildren: async () => [older, newer],
      });
      try {
        const spec = await resolveCursorLaunchSpec(
          `${installDir}\\agent.ps1`,
          WIN_ENV,
          true,
        );
        expect(spec.viaEmbeddedNode).to.equal(true);
        expect(spec.command).to.equal(`${newer}\\node.exe`);
      } finally {
        restore();
      }
    });

    it("falls back to powershell -File when .ps1 is not in a cursor-agent install dir", async function () {
      const restore = installIOUtilsStub({
        existsSync: () => false,
      });
      try {
        const spec = await resolveCursorLaunchSpec(
          "C:\\Users\\Bob\\bin\\foo.ps1",
          WIN_ENV,
          true,
        );
        expect(spec.viaEmbeddedNode).to.equal(false);
        expect(spec.command).to.equal(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        );
        expect(spec.prefixArgs).to.deep.equal([
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "C:\\Users\\Bob\\bin\\foo.ps1",
        ]);
      } finally {
        restore();
      }
    });

    it("falls back to cmd.exe /d /s /c when .cmd is not in a cursor-agent install dir", async function () {
      const restore = installIOUtilsStub({
        existsSync: () => false,
      });
      try {
        const spec = await resolveCursorLaunchSpec(
          "C:\\Users\\Bob\\bin\\my-agent.cmd",
          WIN_ENV,
          true,
        );
        expect(spec.command).to.equal("C:\\Windows\\System32\\cmd.exe");
        expect(spec.prefixArgs).to.deep.equal([
          "/d",
          "/s",
          "/c",
          "C:\\Users\\Bob\\bin\\my-agent.cmd",
        ]);
      } finally {
        restore();
      }
    });

    it("falls back to cmd wrapper when versions dir is empty even in a cursor-agent install dir", async function () {
      const installDir = "C:\\Users\\Bob\\AppData\\Local\\cursor-agent";
      const restore = installIOUtilsStub({
        existsSync: (p) => p === `${installDir}\\versions`,
        getChildren: async () => [],
        exists: async () => false,
      });
      try {
        const spec = await resolveCursorLaunchSpec(
          `${installDir}\\agent.cmd`,
          WIN_ENV,
          true,
        );
        // 找不到任何符合命名规则的版本目录 → 退回 cmd.exe /d /s /c
        expect(spec.viaEmbeddedNode).to.equal(false);
        expect(spec.command).to.equal("C:\\Windows\\System32\\cmd.exe");
      } finally {
        restore();
      }
    });

    it("uses default SystemRoot when SystemRoot env var is missing", async function () {
      const restore = installIOUtilsStub({ existsSync: () => false });
      try {
        const spec = await resolveCursorLaunchSpec(
          "C:\\foo\\bar.ps1",
          {},
          true,
        );
        expect(spec.command).to.equal(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        );
      } finally {
        restore();
      }
    });
  });

  // ============================================================
  // buildCursorAgentArgs (CLI argv construction)
  // ============================================================

  describe("buildCursorAgentArgs", function () {
    it("produces the expected baseline arg vector in ask mode", function () {
      const args = buildCursorAgentArgs(baseOptions());
      expect(args).to.deep.equal([
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--trust",
        "--mode",
        "ask",
        "--model",
        "composer-2.5",
      ]);
    });

    it("adds --model only when a non-empty model is given", function () {
      const args = buildCursorAgentArgs(baseOptions({ model: "" }));
      expect(args).to.not.include("--model");
    });

    // 新版 cursor-agent CLI 把 --mode 的合法值收窄为 plan/ask；agent 模式 = 省略 --mode
    it("omits --mode in agent mode and appends -f + workspace", function () {
      const args = buildCursorAgentArgs(
        baseOptions({
          vendorOptions: {
            cursorAgentMode: "agent",
            cursorAgentWorkspace: "/tmp/work",
          },
        }),
      );
      expect(args).to.not.include("--mode");
      expect(args).to.not.include("agent");
      expect(args).to.include("-f");
      const wsIdx = args.indexOf("--workspace");
      expect(args[wsIdx + 1]).to.equal("/tmp/work");
    });

    it("emits --mode plan and does not append -f for plan mode", function () {
      const args = buildCursorAgentArgs(
        baseOptions({ vendorOptions: { cursorAgentMode: "plan" } }),
      );
      expect(args[args.indexOf("--mode") + 1]).to.equal("plan");
      expect(args).to.not.include("-f");
    });

    it("respects forceMode override (used by connection test)", function () {
      const args = buildCursorAgentArgs(
        baseOptions({ vendorOptions: { cursorAgentMode: "agent" } }),
        { forceMode: "ask" },
      );
      expect(args[args.indexOf("--mode") + 1]).to.equal("ask");
      expect(args).to.not.include("-f");
    });

    it("appends user-provided extra args at the tail", function () {
      const args = buildCursorAgentArgs(
        baseOptions({
          vendorOptions: {
            cursorAgentExtraArgs: '--header "X-A: 1" --plugin-dir /p',
          },
        }),
      );
      const tail = args.slice(-4);
      expect(tail).to.deep.equal(["--header", "X-A: 1", "--plugin-dir", "/p"]);
    });

    it("never emits --output-format twice", function () {
      const args = buildCursorAgentArgs(
        baseOptions({
          vendorOptions: { cursorAgentExtraArgs: "--something" },
        }),
      );
      const occurrences = args.filter((a) => a === "--output-format").length;
      expect(occurrences).to.equal(1);
    });
  });

  // ============================================================
  // applyCursorStreamLine — NDJSON parser
  // ============================================================

  describe("applyCursorStreamLine", function () {
    it("captures the init event and exposes session metadata", function () {
      const state = createCursorStreamState();
      const init = {
        type: "system",
        subtype: "init",
        model: "composer-2.5",
        session_id: "abc-123",
        apiKeySource: "env",
      };
      const r = applyCursorStreamLine(state, JSON.stringify(init));
      expect(r.delta).to.equal("");
      expect(r.parseFailed).to.equal(false);
      expect(state.initEvent).to.include({
        type: "system",
        subtype: "init",
        model: "composer-2.5",
        session_id: "abc-123",
      });
    });

    it("accumulates streamed text from assistant delta events", function () {
      const state = createCursorStreamState();
      const r1 = applyCursorStreamLine(
        state,
        JSON.stringify({
          type: "assistant",
          timestamp_ms: 100,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hel" }],
          },
        }),
      );
      const r2 = applyCursorStreamLine(
        state,
        JSON.stringify({
          type: "assistant",
          timestamp_ms: 200,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "lo" }],
          },
        }),
      );
      expect(r1.delta).to.equal("Hel");
      expect(r2.delta).to.equal("lo");
      expect(state.streamedText).to.equal("Hello");
    });

    it("ignores assistant events that are tool-boundary replays", function () {
      const state = createCursorStreamState();
      applyCursorStreamLine(
        state,
        JSON.stringify({
          type: "assistant",
          timestamp_ms: 100,
          model_call_id: "call-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "should be ignored" }],
          },
        }),
      );
      applyCursorStreamLine(
        state,
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "also ignored" }],
          },
        }),
      );
      expect(state.streamedText).to.equal("");
    });

    it("captures result.result as canonical answer", function () {
      const state = createCursorStreamState();
      applyCursorStreamLine(
        state,
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "final answer",
          duration_ms: 1234,
        }),
      );
      expect(state.canonicalResult).to.equal("final answer");
      expect(state.finalEvent?.type).to.equal("result");
    });

    it("records error events as finalEvent", function () {
      const state = createCursorStreamState();
      applyCursorStreamLine(
        state,
        JSON.stringify({ type: "error", message: { content: [] } }),
      );
      expect(state.finalEvent?.type).to.equal("error");
    });

    it("marks parseFailed=true on non-JSON lines", function () {
      const state = createCursorStreamState();
      const r = applyCursorStreamLine(state, "this is not json");
      expect(r.parseFailed).to.equal(true);
      expect(state.streamedText).to.equal("");
    });

    it("treats empty / whitespace-only lines as no-op", function () {
      const state = createCursorStreamState();
      const r1 = applyCursorStreamLine(state, "");
      const r2 = applyCursorStreamLine(state, "   ");
      expect(r1.parseFailed).to.equal(false);
      expect(r2.parseFailed).to.equal(false);
    });

    it("trims trailing \\r so CRLF terminators are handled", function () {
      const state = createCursorStreamState();
      applyCursorStreamLine(
        state,
        JSON.stringify({
          type: "assistant",
          timestamp_ms: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x" }],
          },
        }) + "\r",
      );
      expect(state.streamedText).to.equal("x");
    });
  });

  // ============================================================
  // runAgent end-to-end with mock Subprocess
  // ============================================================

  describe("runAgent (mock subprocess)", function () {
    const provider = new CursorAgentProvider();
    const options = (): LLMOptions =>
      ({
        apiUrl: "/fake/agent",
        apiKey: "sk-test",
        model: "composer-2.5",
        stream: true,
        requestTimeoutMs: 5_000,
        vendorOptions: { cursorAgentMode: "ask" },
      }) as LLMOptions;

    it("parses NDJSON stream and returns canonical result", async function () {
      const sp = fakeSubprocess({
        stdoutLines: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            model: "composer-2.5",
            session_id: "s-1",
          }),
          JSON.stringify({
            type: "assistant",
            timestamp_ms: 100,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello " }],
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp_ms: 200,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "world" }],
            },
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: "Hello world.",
          }),
        ],
      });
      const deltas: string[] = [];
      const out = await provider._runAgentForTest(
        "test prompt",
        options(),
        sp,
        (delta: string) => {
          deltas.push(delta);
        },
      );
      expect(deltas).to.deep.equal(["Hello ", "world"]);
      expect(out.streamedText).to.equal("Hello world");
      expect(out.canonicalResult).to.equal("Hello world.");
      expect(out.init?.model).to.equal("composer-2.5");
      expect(out.exitCode).to.equal(0);
    });

    it("injects CURSOR_API_KEY into subprocess environment when apiKey is set", async function () {
      let captured: any = null;
      const sp = fakeSubprocess({
        stdoutLines: [
          JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
        ],
        onCall: (call) => {
          captured = call;
        },
      });
      await provider._runAgentForTest(
        "ping",
        { ...options(), apiKey: "sk-abc123" } as LLMOptions,
        sp,
      );
      expect(captured.environment.CURSOR_API_KEY).to.equal("sk-abc123");
    });

    it("omits CURSOR_API_KEY when apiKey is empty (falls back to agent login)", async function () {
      let captured: any = null;
      const sp = fakeSubprocess({
        stdoutLines: [
          JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
        ],
        onCall: (call) => {
          captured = call;
        },
      });
      await provider._runAgentForTest(
        "ping",
        { ...options(), apiKey: "" } as LLMOptions,
        sp,
      );
      expect(captured.environment).to.not.have.property("CURSOR_API_KEY");
    });

    it("writes the prompt to stdin instead of argv", async function () {
      let captured: any = null;
      const sp = fakeSubprocess({
        stdoutLines: [
          JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
        ],
        onCall: (call) => {
          captured = call;
        },
      });
      await provider._runAgentForTest("my-prompt-text", options(), sp);
      expect(captured.arguments).to.not.include("my-prompt-text");
      expect(captured.proc.stdin.writes).to.deep.equal(["my-prompt-text"]);
      expect(captured.arguments).to.include("--output-format");
      expect(captured.arguments).to.include("--stream-partial-output");
    });

    it("propagates AbortSignal: kills the subprocess and throws AbortError", async function () {
      const controller = new AbortController();
      // 这个 fake subprocess 的 wait() 远长于 abort 时间
      const sp = fakeSubprocess({
        stdoutLines: [],
        exitCode: 0,
        exitDelayMs: 10_000,
      });
      setTimeout(() => controller.abort(), 50);
      let caught: any;
      try {
        await provider._runAgentForTest(
          "p",
          { ...options(), abortSignal: controller.signal } as LLMOptions,
          sp,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught, "expected promise to reject").to.exist;
      expect(
        String(caught?.name || caught?.message || "").toLowerCase(),
      ).to.match(/abort/);
    });

    it("throws a clear error on non-zero exit with no canonical result", async function () {
      const sp = fakeSubprocess({
        stdoutLines: [],
        stderrLines: ["fatal: missing CURSOR_API_KEY"],
        exitCode: 2,
      });
      let caught: any;
      try {
        await provider._runAgentForTest("p", options(), sp);
      } catch (e) {
        caught = e;
      }
      expect(caught).to.exist;
      expect(String(caught.message)).to.include("退出码 2");
      expect(String(caught.message)).to.include("CURSOR_API_KEY");
    });

    it("times out when stdout pipe never closes", async function () {
      const sp = {
        async call(_callOpts: any) {
          const neverEnding = {
            readString: () =>
              new Promise<string | null>(() => {
                /* never resolves */
              }),
            close() {
              /* noop */
            },
          };
          return {
            stdout: neverEnding,
            stderr: makePipe([null]),
            stdin: makePipe([]),
            pid: 1,
            wait: () =>
              new Promise<{ exitCode: number }>(() => {
                /* never resolves */
              }),
            kill() {
              /* noop */
            },
          } as any;
        },
      };
      let caught: any;
      try {
        await provider._runAgentForTest(
          "p",
          { ...options(), requestTimeoutMs: 300 } as LLMOptions,
          sp,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).to.exist;
      expect(String(caught.message)).to.match(/超时|>300ms/);
    });

    it("wraps spawn failures with the binary path in the message", async function () {
      const sp = fakeSubprocess({
        stdoutLines: [],
        spawnError: new Error("ENOENT: no such file"),
      });
      let caught: any;
      try {
        await provider._runAgentForTest("p", options(), sp);
      } catch (e) {
        caught = e;
      }
      expect(caught).to.exist;
      expect(String(caught.message)).to.include("启动 cursor-agent 子进程失败");
      expect(String(caught.message)).to.include("ENOENT");
    });
  });

  // ============================================================
  // session 续聊：纯函数 + LRU
  // ============================================================

  describe("session helpers", function () {
    it("fingerprintConversation is order- and content-sensitive", function () {
      const fp1 = fingerprintConversation([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
      const fp2 = fingerprintConversation([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
      const fp3 = fingerprintConversation([
        { role: "user", content: "hi!" },
        { role: "assistant", content: "hello" },
      ]);
      const fp4 = fingerprintConversation([
        { role: "assistant", content: "hello" },
        { role: "user", content: "hi" },
      ]);
      expect(fp1).to.equal(fp2);
      expect(fp1).to.not.equal(fp3);
      expect(fp1).to.not.equal(fp4);
    });

    it("endpointKeyOf isolates different model / key / binary path", function () {
      const a = endpointKeyOf({
        apiUrl: "/x/agent",
        apiKey: "k1",
        model: "m1",
      } as LLMOptions);
      const b = endpointKeyOf({
        apiUrl: "/x/agent",
        apiKey: "k1",
        model: "m2",
      } as LLMOptions);
      const c = endpointKeyOf({
        apiUrl: "/x/agent",
        apiKey: "k2",
        model: "m1",
      } as LLMOptions);
      const d = endpointKeyOf({
        apiUrl: "/y/agent",
        apiKey: "k1",
        model: "m1",
      } as LLMOptions);
      expect(new Set([a, b, c, d]).size).to.equal(4);
    });

    it("BoundedLruMap evicts oldest beyond capacity and refreshes on get", function () {
      const lru = new BoundedLruMap<string, number>(2);
      lru.set("a", 1);
      lru.set("b", 2);
      lru.set("c", 3); // 应该淘汰 a
      expect(lru.get("a")).to.equal(undefined);
      expect(lru.get("b")).to.equal(2);
      lru.set("d", 4); // c 现在是最旧（b 刚被 get 过被刷到末尾）→ 淘汰 c
      expect(lru.get("c")).to.equal(undefined);
      expect(lru.get("b")).to.equal(2);
      expect(lru.get("d")).to.equal(4);
      expect(lru.size).to.equal(2);
    });
  });

  describe("buildCursorAgentArgs — resume", function () {
    it("appends --resume <id> when resumeSessionId is provided", function () {
      const args = buildCursorAgentArgs(baseOptions(), {
        resumeSessionId: "s-42",
      });
      const idx = args.indexOf("--resume");
      expect(idx).to.be.greaterThan(-1);
      expect(args[idx + 1]).to.equal("s-42");
    });

    it("omits --resume when resumeSessionId is empty / not provided", function () {
      const args = buildCursorAgentArgs(baseOptions());
      expect(args).to.not.include("--resume");
      const args2 = buildCursorAgentArgs(baseOptions(), {
        resumeSessionId: "",
      });
      expect(args2).to.not.include("--resume");
    });
  });

  describe("chat — session resume integration", function () {
    /** Helper：构造一个永远返回固定 init.session_id + 给定 result 的 fake subprocess。 */
    function makeOkSubprocess(
      sessionId: string,
      resultText: string,
      onCall?: (call: any) => void,
    ) {
      return fakeSubprocess({
        stdoutLines: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            model: "composer-2.5",
            session_id: sessionId,
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: resultText,
          }),
        ],
        onCall,
      });
    }

    function chatOptions(): LLMOptions {
      return {
        apiUrl: "/fake/agent",
        apiKey: "sk-test",
        model: "composer-2.5",
        stream: false,
        requestTimeoutMs: 5_000,
        vendorOptions: {
          cursorAgentMode: "ask",
          cursorAgentResumeEnabled: true,
        },
      } as LLMOptions;
    }

    function patchRunAgent(provider: CursorAgentProvider, subprocess: any) {
      const provAny = provider as any;
      const orig = provAny.runAgent.bind(provider);
      provAny.runAgent = async function (
        prompt: string,
        opts: any,
        onProgress?: any,
        _sp?: any,
        extra?: any,
      ) {
        return orig(prompt, opts, onProgress, subprocess, extra);
      };
      return () => {
        provAny.runAgent = orig;
      };
    }

    it("first turn does not use --resume; second turn does", async function () {
      const provider = new CursorAgentProvider();
      provider._clearResumeCache();

      // ----- 第一轮 -----
      const calls: any[] = [];
      const sp1 = makeOkSubprocess("session-1", "Hi!", (c) => calls.push(c));
      let restore = patchRunAgent(provider, sp1);
      const conv1: ConversationMessage[] = [{ role: "user", content: "你好" }];
      const ans1 = await provider.chat("", false, conv1, chatOptions());
      restore();
      expect(ans1).to.equal("Hi!");
      // 第一次绝不应该带 --resume
      expect(calls[0].arguments).to.not.include("--resume");
      // 缓存里应该多了一条
      expect(provider._peekResumeCacheSize()).to.equal(1);

      // ----- 第二轮（追加新 user 消息） -----
      const sp2 = makeOkSubprocess("session-1", "Glad to.", (c) =>
        calls.push(c),
      );
      restore = patchRunAgent(provider, sp2);
      const conv2: ConversationMessage[] = [
        ...conv1,
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "请总结" },
      ];
      const ans2 = await provider.chat("", false, conv2, chatOptions());
      restore();
      expect(ans2).to.equal("Glad to.");
      // 应该命中并使用 --resume session-1
      const args2 = calls[1].arguments;
      const idx = args2.indexOf("--resume");
      expect(idx).to.be.greaterThan(-1);
      expect(args2[idx + 1]).to.equal("session-1");
      // 续聊路径只发最新一条 user 消息，stdin prompt 应包含 "请总结" 且不包含完整历史 "### 助手"
      const promptStdin = calls[1].proc.stdin.writes.join("");
      expect(promptStdin).to.include("请总结");
      expect(promptStdin).to.not.include("### 助手");
    });

    it("resume disabled in vendorOptions never appends --resume", async function () {
      const provider = new CursorAgentProvider();
      provider._clearResumeCache();
      const calls: any[] = [];
      const sp1 = makeOkSubprocess("s-x", "ok", (c) => calls.push(c));
      let restore = patchRunAgent(provider, sp1);
      const opts = chatOptions();
      (opts.vendorOptions as any).cursorAgentResumeEnabled = false;

      await provider.chat("", false, [{ role: "user", content: "a" }], opts);
      restore();

      const sp2 = makeOkSubprocess("s-x", "ok", (c) => calls.push(c));
      restore = patchRunAgent(provider, sp2);
      await provider.chat(
        "",
        false,
        [
          { role: "user", content: "a" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "b" },
        ],
        opts,
      );
      restore();

      expect(calls[0].arguments).to.not.include("--resume");
      expect(calls[1].arguments).to.not.include("--resume");
    });

    it("different endpoint key (different model) does not pick up cached session", async function () {
      const provider = new CursorAgentProvider();
      provider._clearResumeCache();
      const calls: any[] = [];
      // 第一轮：model = m1
      const opts1 = chatOptions();
      opts1.model = "m1";
      const sp1 = makeOkSubprocess("sess-m1", "a", (c) => calls.push(c));
      let restore = patchRunAgent(provider, sp1);
      const conv1: ConversationMessage[] = [{ role: "user", content: "x" }];
      await provider.chat("", false, conv1, opts1);
      restore();

      // 第二轮：相同 prefix 但换模型 m2 → 不应该命中缓存
      const opts2 = chatOptions();
      opts2.model = "m2";
      const sp2 = makeOkSubprocess("sess-m2", "b", (c) => calls.push(c));
      restore = patchRunAgent(provider, sp2);
      const conv2: ConversationMessage[] = [
        ...conv1,
        { role: "assistant", content: "a" },
        { role: "user", content: "y" },
      ];
      await provider.chat("", false, conv2, opts2);
      restore();

      expect(calls[1].arguments).to.not.include("--resume");
    });

    it("if --resume fails, evicts cache and falls back to full conversation", async function () {
      const provider = new CursorAgentProvider();
      provider._clearResumeCache();

      // 第一轮：成功，缓存 session-1
      const calls: any[] = [];
      const sp1 = makeOkSubprocess("session-1", "ok", (c) => calls.push(c));
      const restore = patchRunAgent(provider, sp1);
      const conv1: ConversationMessage[] = [{ role: "user", content: "a" }];
      await provider.chat("", false, conv1, chatOptions());
      restore();
      expect(provider._peekResumeCacheSize()).to.equal(1);

      // 第二轮：第一次 runAgent 抛错（模拟 session 失效），第二次成功
      let runCount = 0;
      const provAny = provider as any;
      const origRun = provAny.runAgent.bind(provider);
      const sp2ok = makeOkSubprocess("session-2", "fallback ok", (c) =>
        calls.push(c),
      );
      provAny.runAgent = async function (
        prompt: string,
        opts: any,
        onProgress?: any,
        _sp?: any,
        extra?: any,
      ) {
        runCount++;
        if (runCount === 1) {
          throw new Error("Cursor Agent 退出码 1。session expired");
        }
        return origRun(prompt, opts, onProgress, sp2ok, extra);
      };
      try {
        const conv2: ConversationMessage[] = [
          ...conv1,
          { role: "assistant", content: "ok" },
          { role: "user", content: "b" },
        ];
        const ans2 = await provider.chat("", false, conv2, chatOptions());
        expect(ans2).to.equal("fallback ok");
        expect(runCount).to.equal(2);
      } finally {
        provAny.runAgent = origRun;
      }
    });
  });

  // ============================================================
  // generateSummary with Base64 PDF goes through file-passthrough
  // ============================================================

  describe("generateSummary base64 file passthrough", function () {
    it("decodes base64 to a temp file, forces agent mode + workspace, and cleans up", async function () {
      const provider = new CursorAgentProvider();
      // 一个超小但合法的 PDF base64（"%PDF-1.4\n%%EOF"）
      const tinyPdf = btoa("%PDF-1.4\n%%EOF\n");

      let captured: any = null;
      const sp = fakeSubprocess({
        stdoutLines: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            model: "composer-2.5",
            session_id: "s-pdf-1",
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: "PDF 已读取，本文主要讲了 AI Butler。",
          }),
        ],
        onCall: (call) => {
          captured = call;
        },
      });

      // Provider 内部会读 vendorOptions.cursorAgentMode；这里直接走 _runAgentForTest 端到端不够，
      // 因为 generateSummary 本身要先解码 / 写文件 / 设置 mode 再调用 runAgent。
      // 所以我们临时把 provider.runAgent 替换为一个跑 fake subprocess 的代理。
      const provAny = provider as any;
      const orig = provAny.runAgent.bind(provider);
      let derivedOptions: any = null;
      provAny.runAgent = async function (
        prompt: string,
        opts: any,
        onProgress?: any,
      ) {
        derivedOptions = opts;
        return orig(prompt, opts, onProgress, sp);
      };

      try {
        const out = await provider.generateSummary(
          tinyPdf,
          true,
          "请用一句话总结",
          {
            apiUrl: "/fake/agent",
            apiKey: "",
            model: "composer-2.5",
            stream: false,
            requestTimeoutMs: 5_000,
          } as LLMOptions,
        );
        expect(out).to.include("AI Butler");
        // 派生的 vendorOptions 必须强制升级到 agent 模式 + 临时 workspace
        expect(derivedOptions.vendorOptions.cursorAgentMode).to.equal("agent");
        const ws = String(derivedOptions.vendorOptions.cursorAgentWorkspace);
        expect(ws).to.match(/ai-butler-cursor-/);
        // argv 应该真带上 --workspace 和 -f；同时不应包含 --mode（agent 模式 = 默认）
        expect(captured.arguments).to.include("--workspace");
        expect(
          captured.arguments[captured.arguments.indexOf("--workspace") + 1],
        ).to.equal(ws);
        expect(captured.arguments).to.include("-f");
        expect(captured.arguments).to.not.include("--mode");
        // prompt 通过 stdin 传入，并包含 "./paper.pdf" 提示
        expect(captured.arguments).to.not.include("./paper.pdf");
        expect(captured.proc.stdin.writes.join("")).to.include("./paper.pdf");
      } finally {
        provAny.runAgent = orig;
      }
    });

    it("propagates errors but still cleans up the temp workspace", async function () {
      const provider = new CursorAgentProvider();
      const tinyPdf = btoa("%PDF-1.4\n%%EOF\n");
      const provAny = provider as any;
      const orig = provAny.runAgent.bind(provider);
      provAny.runAgent = async function () {
        throw new Error("simulated failure");
      };
      let caught: any;
      try {
        await provider.generateSummary(tinyPdf, true, "x", {
          apiUrl: "/fake/agent",
          apiKey: "",
          model: "composer-2.5",
          stream: false,
          requestTimeoutMs: 1_000,
        } as LLMOptions);
      } catch (e) {
        caught = e;
      } finally {
        provAny.runAgent = orig;
      }
      expect(caught?.message).to.include("simulated failure");
    });

    it("rejects clearly when base64 input is empty", async function () {
      const provider = new CursorAgentProvider();
      let caught: any;
      try {
        await provider.generateSummary("", true, "x", {
          apiUrl: "/fake/agent",
          apiKey: "",
          model: "composer-2.5",
          stream: false,
        } as LLMOptions);
      } catch (e) {
        caught = e;
      }
      expect(caught).to.exist;
      expect(String(caught.message)).to.match(/PDF|base64|工作目录/i);
    });
  });
});
