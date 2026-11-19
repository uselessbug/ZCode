import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Emitter, Event, type IDisposable } from "@zcode/rpc";
import type { IPty } from "node-pty";
import type { ISettingService } from "../setting/setting.js";
import type {
  IStandaloneTerminalService,
  ITerminalService,
  TerminalWindowsPtyInfo,
} from "./terminal.js";
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import("node-pty");
type PtySpawnOptions = Parameters<NodePtyModule["spawn"]>[2];

interface TerminalInstance {
  pty: IPty;
  dataEmitter: Emitter<string>;
  exitEmitter: Emitter<number>;
  /** 启动时的工作目录；shell 内 cd 之后的目录无法追踪（docs/git/worktree.md §12 第 4 项）。 */
  cwd: string;
}

let hasEnsuredNodePtyHelper = false;
let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

async function loadNodePtyModule(): Promise<NodePtyModule> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      const message = error instanceof Error ? error.message : String(error);
      // remote server 启动时会先创建所有服务，之前这里顶层 import node-pty，
      // 只要当前平台缺少 pty.node，就会在服务注册阶段直接崩掉，整条远程连接链路都失败。
      // 改成延迟加载后，server 可以先完成握手，仅在真正创建终端时再暴露“terminal 不可用”的错误。
      throw new Error(`node-pty is unavailable in this runtime: ${message}`);
    }) as Promise<NodePtyModule>;
  }

  return nodePtyModulePromise;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseWindowsBuildNumber(releaseText: string): number | undefined {
  const buildText = releaseText.split(".")[2];
  if (!buildText) return undefined;
  const buildNumber = Number.parseInt(buildText, 10);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

export function resolveTerminalWindowsPtyInfo(
  platform: NodeJS.Platform = process.platform,
  releaseText: string = release(),
): TerminalWindowsPtyInfo | undefined {
  if (platform !== "win32") return undefined;

  return {
    backend: "conpty",
    buildNumber: parseWindowsBuildNumber(releaseText),
  };
}

function isExecutable(command: string): boolean {
  try {
    if (/[\\/]/.test(command)) {
      accessSync(command, constants.X_OK);
      return true;
    }

    const pathEnv = process.env.PATH;
    if (!pathEnv) return false;

    return pathEnv.split(delimiter).some((dir) => {
      if (!dir) return false;
      try {
        accessSync(join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform !== "darwin") return null;

  try {
    const utils = require("node-pty/lib/utils") as {
      loadNativeModule(name: string): { dir: string };
    };
    const native = utils.loadNativeModule("pty");
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

    let helperPath = resolve(dirname(unixTerminalPath), `${native.dir}/spawn-helper`);
    helperPath = helperPath.replace("app.asar", "app.asar.unpacked");
    helperPath = helperPath.replace("node_modules.asar", "node_modules.asar.unpacked");
    return helperPath;
  } catch {
    return null;
  }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (hasEnsuredNodePtyHelper || process.platform !== "darwin") return;
  hasEnsuredNodePtyHelper = true;

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath || !existsSync(helperPath)) return;

  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // 当前环境里的 node-pty spawn-helper 丢了执行权限，
    // child_process.spawn 还能工作，但 node-pty 在 macOS 上启动伪终端时会先调用这个 helper，
    // helper 不可执行就会直接报 posix_spawnp failed。
    // 这里在真正 spawn 前把 helper 修正为 0755，避免终端因为安装产物权限漂移而无法打开。
  }

  try {
    chmodSync(helperPath, 0o755);
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`node-pty spawn-helper is not executable: ${helperPath}. ${message}`);
  }
}

function shouldFallbackFromConptyDll(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(
    message,
  );
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

const DARWIN_GUI_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of entries) {
    for (const entry of value?.split(delimiter) ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }

  return merged.join(delimiter);
}

function resolveDarwinTerminalPath(env: NodeJS.ProcessEnv): string {
  return mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS]);
}

function resolveFallbackUtf8Locale(env: NodeJS.ProcessEnv): string {
  const inheritedUtf8Locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;

  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

export function resolveTerminalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const fallbackLocale = resolveFallbackUtf8Locale(env);

  // macOS 从 Dock/Finder/登录项启动 Electron 时，父进程通常只带 /usr/bin:/bin:/usr/sbin:/sbin，
  // 甚至缺失 PATH；内置终端虽然打开了登录 shell，但 zsh/bash 仍会先继承这个过窄 PATH，
  // 导致 ls 以外的 npm/node/pnpm 等常用命令找不到，部分用户的 profile 又不会重新补齐。
  // 这里仅在传给 terminal 的环境里补常见 Homebrew 与系统路径，不改全局 process.env，并保留用户已有顺序。
  if (process.platform === "darwin") {
    nextEnv.PATH = resolveDarwinTerminalPath(env);
  }

  // runtime 登录 shell 环境采集会用 TERM=dumb / CI=1 来避免 profile 脚本进入交互分支，
  // 但真实 terminal panel 必须作为交互终端启动，否则 starship、p10k、颜色能力检测等会降级成无样式输出。
  nextEnv.TERM = "xterm-256color";
  nextEnv.COLORTERM = nextEnv.COLORTERM?.trim() || "truecolor";
  if (nextEnv.CI === "1" && env.TERM === "dumb") {
    delete nextEnv.CI;
  }

  // Electron 从 GUI 启动时 host process 可能继承不到登录 shell 的 UTF-8 locale，
  // 子 shell 会落到 C/POSIX locale，中文路径会被 zsh/bash 显示成 \M-^ 这类转义乱码。
  // 这里只在 locale 缺失或明确为 C/POSIX 时补 UTF-8，保留用户已经配置好的 UTF-8 locale。
  if (isMissingOrCLocale(nextEnv.LANG)) {
    nextEnv.LANG = fallbackLocale;
  }
  if (isMissingOrCLocale(nextEnv.LC_CTYPE)) {
    nextEnv.LC_CTYPE = fallbackLocale;
  }
  if (nextEnv.LC_ALL !== undefined && isMissingOrCLocale(nextEnv.LC_ALL)) {
    nextEnv.LC_ALL = fallbackLocale;
  }

  return nextEnv;
}

function spawnTerminalProcess(params: {
  nodePty: NodePtyModule;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): IPty {
  const { nodePty, shell, cols, rows, cwd, env } = params;

  if (process.platform !== "win32") {
    return nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      encoding: "utf8",
    });
  }

  const windowsBaseOptions = {
    useConpty: true,
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } satisfies PtySpawnOptions;

  try {
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: true,
    });
  } catch (error) {
    if (!shouldFallbackFromConptyDll(error)) {
      throw error;
    }

    // Windows 下开启 node-pty 的实验性 useConptyDll 时，某些 Electron/安装包环境会在 shell 真正启动前
    // 就因为 conpty.node / conpty.dll 的原生模块定位失败直接报错，导致终端整个打不开。
    // 这里仅在命中这类 DLL 加载错误时回退到系统内置 ConPTY，既保留新版路径的优先级，也避免把普通启动失败误判成可重试。
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: false,
    });
  }
}

export function resolveTerminalShell(): string {
  if (process.platform === "win32") {
    // Windows PowerShell 5.1 的 PSReadLine 在 ConPTY 下更容易把输入行空白重绘成 ANSI black 背景。
    // PowerShell 7+ 的终端兼容性更接近桌面端，优先使用已安装的 pwsh，找不到再回退到系统自带 shell。
    const candidates = ["pwsh.exe", "powershell.exe", process.env.ComSpec, "cmd.exe"];

    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) return candidate;
    }

    throw new Error("No usable Windows shell found for terminal startup");
  }

  // 之前直接信任 SHELL 环境变量，外部环境如果残留了一个不存在的 shell 路径，
  // node-pty 底层会把这个坏路径直接交给 posix_spawnp，终端创建时就会报错。
  // 这里先校验 SHELL 是否真的可执行，不可用时再按常见 shell 顺序回退，避免启动直接失败。
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];

  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  throw new Error("No usable shell found for terminal startup");
}

export function resolveTerminalCwd(cwd?: string): string {
  // 修复原因：工作区目录可能已经被删除、移动，或者启动时传进来的是一个失效路径。
  // 之前把这个 cwd 原样传给 node-pty，同样会在 spawn 阶段失败。
  // 这里优先使用传入目录，不可用时回退到 HOME / 系统 home / 根目录，保证终端还能拉起。
  const candidates = [cwd, process.env.HOME, homedir(), "/"];

  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }

  throw new Error("No usable working directory found for terminal startup");
}

/** 无监听者期间最多保留的 PTY 输出字符数；超出后丢弃最旧的块，保留屏幕上最可能仍可见的尾部。 */
const TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS = 1_048_576;

/**
 * Bug 原因（R3 远端终端 xterm 恒空，2026-09-14）：PTY 的首批输出（bash 提示符在 spawn 后约 10ms 就到达）
 * 在 renderer 通过 create() 拿到 id 并订阅 onDynamicData 之前就已 fire，而普通 Emitter 在没有监听者时
 * 直接丢弃事件，ProxyChannel 对 onDynamicXxx 也不做缓冲。本地链路往返只有毫秒级，多数时候能抢在提示符
 * 之前订阅；远端目标经 SSH 往返 40~200ms，首个提示符必丢，之后 shell 空闲再无输出，用户看到空白终端。
 * 修法：输出的唯一来源在这里，于是在没有监听者时把输出有界缓存，监听者到来后按序回放再转直通。
 * 订阅断开（例如远端连接换代）期间同样缓存，避免重连后丢失中间输出；不依赖任何超时。
 */
function createBufferedTerminalOutputEmitter(): {
  emitter: Emitter<string>;
  push: (data: string) => void;
} {
  const pending: string[] = [];
  let pendingChars = 0;
  let hasListener = false;

  const emitter: Emitter<string> = new Emitter<string>({
    // Emitter 会先登记监听者再触发该钩子，因此这里 fire 能直接送达刚订阅的监听者。
    onWillAddFirstListener: () => {
      hasListener = true;
      const buffered = pending.splice(0);
      pendingChars = 0;
      for (const chunk of buffered) {
        emitter.fire(chunk);
      }
    },
    onDidRemoveLastListener: () => {
      hasListener = false;
    },
  });

  return {
    emitter,
    push: (data) => {
      if (hasListener) {
        emitter.fire(data);
        return;
      }
      pending.push(data);
      pendingChars += data.length;
      while (pendingChars > TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS && pending.length > 1) {
        pendingChars -= pending.shift()?.length ?? 0;
      }
    },
  };
}

export function createTerminalService(dependencies: {
  settingService: ISettingService;
  /** cwd 位于删除中的受管 worktree 时返回 true（docs/git/worktree.md §8.3）。 */
  isCwdBlocked?: (cwd: string) => boolean;
}): ITerminalService {
  const terminals = new Map<string, TerminalInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 pty 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("terminal", () => ({
    open: terminals.size,
  }));

  function getTerminal(id: string): TerminalInstance {
    const t = terminals.get(id);
    if (!t) throw new Error(`Terminal not found: ${id}`);
    return t;
  }

  function cleanupTerminal(id: string): void {
    const terminal = terminals.get(id);
    if (!terminal) {
      return;
    }

    terminal.pty.kill();
    terminal.dataEmitter.dispose();
    terminal.exitEmitter.dispose();
    terminals.delete(id);
  }

  const service: ITerminalService & { disposeAll(): void } = {
    async create(params: { cols: number; rows: number; cwd?: string }): Promise<{
      id: string;
      shell: string;
      fontFamily: string;
      fontSize?: number;
      theme?: TerminalThemeProfile;
      fontFamilySource: TerminalFontFamilySource;
      windowsPty?: TerminalWindowsPtyInfo;
    }> {
      const id = String(nextId++);
      const shell = resolveTerminalShell();
      const cwd = resolveTerminalCwd(params.cwd);
      const env = resolveTerminalEnv();
      const terminalProfileSettings = await dependencies.settingService.get().catch(() => ({
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      }));
      const fontProfile = resolveTerminalFontProfile({
        settings: terminalProfileSettings,
        env: process.env,
      });
      const nodePty = await loadNodePtyModule();
      ensureNodePtySpawnHelperExecutable();
      const terminalOutput = createBufferedTerminalOutputEmitter();
      const dataEmitter = terminalOutput.emitter;
      const exitEmitter = new Emitter<number>();

      // 检查、启动与登记在同一段同步代码中：删除方取得租约后列出的终端一定包含已启动的终端。
      if (dependencies.isCwdBlocked?.(cwd)) throw new Error("worktree.removing");
      let p: IPty;
      try {
        p = spawnTerminalProcess({
          nodePty,
          shell,
          cols: params.cols,
          rows: params.rows,
          cwd,
          env,
        });
      } catch (error) {
        throw new Error(
          `Failed to start terminal with shell '${shell}' in '${cwd}': ${getErrorMessage(error)}`,
        );
      }

      p.onData((data) => terminalOutput.push(data));
      p.onExit(({ exitCode }) => {
        exitEmitter.fire(exitCode);
        dataEmitter.dispose();
        exitEmitter.dispose();
        terminals.delete(id);
      });

      terminals.set(id, { pty: p, dataEmitter, exitEmitter, cwd });
      return {
        id,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
    },

    async write(params: { id: string; data: string }): Promise<void> {
      getTerminal(params.id).pty.write(params.data);
    },

    async resize(params: { id: string; cols: number; rows: number }): Promise<void> {
      getTerminal(params.id).pty.resize(params.cols, params.rows);
    },

    async dispose(params: { id: string }): Promise<void> {
      cleanupTerminal(params.id);
    },

    async listTerminalIdsUnderPath(params: { path: string }): Promise<string[]> {
      const root = resolve(params.path);
      return [...terminals.entries()]
        .filter(([, terminal]) => {
          const rel = relative(root, resolve(terminal.cwd));
          return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
        })
        .map(([id]) => id);
    },

    onDynamicData(id: string): Event<string> {
      return getTerminal(id).dataEmitter.event;
    },

    onDynamicExit(id: string): Event<number> {
      return getTerminal(id).exitEmitter.event;
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      // app 关闭时 host process 以前只会结束自身，terminal 里的子 shell 没有逐个显式 kill。
      // 这里补一个本地清理入口，让 host 在退出链路里能同步回收所有仍存活的终端进程。
      for (const id of Array.from(terminals.keys())) {
        cleanupTerminal(id);
      }
    },
  };

  return service;
}

/** 旧客户端没有页面 owner 时按 attachment 回收，避免继续产生无主 PTY。 */
export function createTerminalScope(
  base: ITerminalService,
  onCleanupError: (error: unknown) => void,
  onTerminalExit?: (id: string, exitCode: number) => void,
) {
  let active = true;
  const terminals = new Map<string, IDisposable>();
  function assertActive(id?: string): void {
    if (!active || (id !== undefined && !terminals.has(id))) {
      throw new Error("Terminal owner has ended or does not own this terminal");
    }
  }
  const release = async (id: string) => {
    await base.dispose({ id });
    terminals.get(id)?.dispose();
    terminals.delete(id);
  };
  const service: ITerminalService = {
    async create(params) {
      assertActive();
      const result = await base.create(params);
      // create 跨 RPC/加载 await；owner 已结束时必须回收返回的真实 PTY，不能只丢响应。
      if (!active) {
        await base.dispose({ id: result.id });
        throw new Error("Terminal owner has ended");
      }
      const subscription = base.onDynamicExit(result.id)((exitCode) => {
        terminals.get(result.id)?.dispose();
        terminals.delete(result.id);
        onTerminalExit?.(result.id, exitCode);
      });
      terminals.set(result.id, subscription);
      return result;
    },
    async write(params) {
      assertActive(params.id);
      await base.write(params);
    },
    async resize(params) {
      assertActive(params.id);
      await base.resize(params);
    },
    async dispose({ id }) {
      if (!active || !terminals.has(id)) return;
      await release(id);
    },
    async listTerminalIdsUnderPath(params) {
      assertActive();
      // attachment 只能看到自己创建的终端，不能借查询枚举 Host 上其他 owner 的终端。
      return (await base.listTerminalIdsUnderPath(params)).filter((id) => terminals.has(id));
    },
    onDynamicData(id) {
      assertActive(id);
      try {
        return base.onDynamicData(id);
      } catch (error) {
        terminals.get(id)?.dispose();
        terminals.delete(id);
        throw error;
      }
    },
    onDynamicExit(id) {
      assertActive(id);
      try {
        return base.onDynamicExit(id);
      } catch (error) {
        terminals.get(id)?.dispose();
        terminals.delete(id);
        throw error;
      }
    },
  };
  return {
    service,
    hasTerminal(id: string): boolean {
      return active && terminals.has(id);
    },
    listOwnedTerminalIds(): string[] {
      return active ? Array.from(terminals.keys()) : [];
    },
    dispose(): void {
      if (!active) return;
      active = false;
      const owned = Array.from(terminals.entries());
      terminals.clear();
      for (const [id, subscription] of owned) {
        subscription.dispose();
        void release(id).catch(onCleanupError);
      }
    },
  };
}

export const DEFAULT_STANDALONE_TERMINAL_OWNER_GRACE_MS = 3_000;
const MAX_RECORDED_EXITED_TERMINALS_PER_OWNER = 200;

export type StandaloneTerminalOwnerBindRequest =
  | { kind: "fresh" }
  | { kind: "resume"; resumeToken: string };

export interface StandaloneTerminalOwnersOptions {
  graceMs?: number;
  onCleanupError: (error: unknown) => void;
  createOwnerId?: () => string;
  createResumeToken?: () => string;
}

export interface StandaloneTerminalConnectionLease {
  ownerId: string;
  resumeToken: string;
  service: IStandaloneTerminalService;
  release(options: { explicitEnd: boolean }): void;
}

export interface StandaloneTerminalOwners {
  bind(
    request: StandaloneTerminalOwnerBindRequest,
    base: ITerminalService,
    onSuperseded?: () => void,
  ): StandaloneTerminalConnectionLease;
  disposeByToken(resumeToken: string): boolean;
  disposeAll(): void;
}

interface StandaloneOwnerEntry {
  ownerId: string;
  resumeToken: string;
  scope: ReturnType<typeof createTerminalScope>;
  exitedCodes: Map<string, number>;
  activeConnectionToken: symbol | undefined;
  onSuperseded: (() => void) | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  releasingStaleIds: Set<string>;
  ended: boolean;
}

function defaultCreateResumeToken(): string {
  return randomBytes(24).toString("base64url");
}

/** 独立 Web 按服务端签发的不可预测 resumeToken 隔离终端作用域，支持短断线 3s 宽限保留与显式立即回收。 */
export function createStandaloneTerminalOwners(
  options: StandaloneTerminalOwnersOptions,
): StandaloneTerminalOwners {
  const graceMs = options.graceMs ?? DEFAULT_STANDALONE_TERMINAL_OWNER_GRACE_MS;
  const createOwnerId = options.createOwnerId ?? randomUUID;
  const createResumeToken = options.createResumeToken ?? defaultCreateResumeToken;
  const owners = new Map<string, StandaloneOwnerEntry>();

  function endOwner(owner: StandaloneOwnerEntry): void {
    if (owner.ended) return;
    owner.ended = true;
    owner.activeConnectionToken = undefined;
    owner.onSuperseded = undefined;
    if (owner.graceTimer !== undefined) {
      clearTimeout(owner.graceTimer);
      owner.graceTimer = undefined;
    }
    if (owners.get(owner.resumeToken) === owner) {
      owners.delete(owner.resumeToken);
    }
    owner.exitedCodes.clear();
    owner.scope.dispose();
  }

  return {
    bind(
      request: StandaloneTerminalOwnerBindRequest,
      base: ITerminalService,
      onSuperseded?: () => void,
    ): StandaloneTerminalConnectionLease {
      // 仅命中有效且未结束的服务端 resumeToken 才能复用既有作用域；未知或已过期的令牌一律创建全新隔离作用域。
      let existing = request.kind === "resume" ? owners.get(request.resumeToken) : undefined;
      if (!existing || existing.ended) {
        const exitedCodes = new Map<string, number>();
        const ownerId = createOwnerId();
        const resumeToken = createResumeToken();
        existing = {
          ownerId,
          resumeToken,
          scope: createTerminalScope(base, options.onCleanupError, (id, exitCode) => {
            if (existing?.ended) return;
            exitedCodes.set(id, exitCode);
            if (exitedCodes.size > MAX_RECORDED_EXITED_TERMINALS_PER_OWNER) {
              const oldest = exitedCodes.keys().next().value;
              if (oldest !== undefined) exitedCodes.delete(oldest);
            }
          }),
          exitedCodes,
          activeConnectionToken: undefined,
          onSuperseded: undefined,
          graceTimer: undefined,
          releasingStaleIds: new Set<string>(),
          ended: false,
        };
        owners.set(resumeToken, existing);
      } else if (existing.graceTimer !== undefined) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = undefined;
      }

      const owner = existing;
      const previousSuperseded = owner.onSuperseded;
      const connectionToken = Symbol("standalone-terminal-connection");
      // 先切换当前连接代际再通知被取代连接，防止旧 socket 在关闭回调里误伤新租约。
      owner.activeConnectionToken = connectionToken;
      owner.onSuperseded = onSuperseded;
      if (previousSuperseded) {
        try {
          previousSuperseded();
        } catch (error) {
          options.onCleanupError(error);
        }
      }

      const isConnectionCurrent = (): boolean =>
        !owner.ended && owner.activeConnectionToken === connectionToken;
      const assertConnectionCurrent = (): void => {
        if (!isConnectionCurrent()) {
          throw new Error("Terminal owner has ended or connection is no longer active");
        }
      };

      const service: IStandaloneTerminalService = {
        async create(params) {
          assertConnectionCurrent();
          const result = await owner.scope.service.create(params);
          if (!isConnectionCurrent()) {
            // 旧连接在 create 等待期间断线或被同页新连接取代，仅回收本次晚到返回的终端。
            owner.releasingStaleIds.add(result.id);
            try {
              await owner.scope.service.dispose({ id: result.id }).catch(options.onCleanupError);
            } finally {
              owner.releasingStaleIds.delete(result.id);
            }
            throw new Error("Terminal connection has closed");
          }
          return result;
        },
        async write(params) {
          assertConnectionCurrent();
          await owner.scope.service.write(params);
        },
        async resize(params) {
          assertConnectionCurrent();
          await owner.scope.service.resize(params);
        },
        async dispose(params) {
          assertConnectionCurrent();
          owner.exitedCodes.delete(params.id);
          await owner.scope.service.dispose(params);
        },
        async listTerminalIdsUnderPath(params) {
          assertConnectionCurrent();
          const ids = await owner.scope.service.listTerminalIdsUnderPath(params);
          return owner.releasingStaleIds.size === 0
            ? ids
            : ids.filter((id) => !owner.releasingStaleIds.has(id));
        },
        onDynamicData(id) {
          assertConnectionCurrent();
          if (owner.scope.hasTerminal(id)) {
            return owner.scope.service.onDynamicData(id);
          }
          if (owner.exitedCodes.has(id)) {
            return Event.None;
          }
          return owner.scope.service.onDynamicData(id);
        },
        onDynamicExit(id) {
          assertConnectionCurrent();
          if (owner.scope.hasTerminal(id)) {
            return owner.scope.service.onDynamicExit(id);
          }
          if (owner.exitedCodes.has(id)) {
            const exitCode = owner.exitedCodes.get(id)!;
            return (listener) => {
              let disposed = false;
              queueMicrotask(() => {
                if (!disposed && isConnectionCurrent()) {
                  listener(exitCode);
                }
              });
              return {
                dispose() {
                  disposed = true;
                },
              };
            };
          }
          return owner.scope.service.onDynamicExit(id);
        },
        async getStandaloneOwnerState() {
          assertConnectionCurrent();
          const ids = owner.scope.listOwnedTerminalIds();
          return {
            ownerId: owner.ownerId,
            resumeToken: owner.resumeToken,
            terminalIds:
              owner.releasingStaleIds.size === 0
                ? ids
                : ids.filter((id) => !owner.releasingStaleIds.has(id)),
          };
        },
      };

      let released = false;
      return {
        ownerId: owner.ownerId,
        resumeToken: owner.resumeToken,
        service,
        release({ explicitEnd }: { explicitEnd: boolean }): void {
          if (released) return;
          released = true;
          if (owner.ended || owner.activeConnectionToken !== connectionToken) {
            return;
          }
          owner.activeConnectionToken = undefined;
          owner.onSuperseded = undefined;
          if (explicitEnd) {
            endOwner(owner);
            return;
          }
          if (owner.graceTimer !== undefined) {
            clearTimeout(owner.graceTimer);
          }
          owner.graceTimer = setTimeout(() => {
            owner.graceTimer = undefined;
            if (!owner.ended && owner.activeConnectionToken === undefined) {
              endOwner(owner);
            }
          }, graceMs);
        },
      };
    },
    disposeByToken(resumeToken: string): boolean {
      const owner = owners.get(resumeToken);
      if (!owner || owner.ended) {
        return false;
      }
      const terminate = owner.onSuperseded;
      endOwner(owner);
      if (terminate) {
        try {
          terminate();
        } catch (error) {
          options.onCleanupError(error);
        }
      }
      return true;
    },
    disposeAll(): void {
      for (const owner of Array.from(owners.values())) {
        endOwner(owner);
      }
    },
  };
}
