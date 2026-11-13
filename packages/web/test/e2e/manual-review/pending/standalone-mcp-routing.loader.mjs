// 独立 Web MCP 路由运行时验收的最小模块解析钩子。
//
// 只做两件事，不模拟被测路由、也不模拟 zustand：
// 1) 把 UI 源码里的路径别名（`@/*`、`@zcode/shared`）映射到仓库真实文件；
// 2) 把与 MCP 目录读写无关的数据同步边界（services/src/data-sync/node.ts）替换为空实现，
//    避免为跑这一条路由把整包数据同步依赖都拉进来。
//
// Node 24 自带 .ts 类型擦除，因此这里不需要 TS transpile，只做 specifier 解析。
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// pending 目录 → 仓库根
const repoRoot = resolvePath(here, "../../../../../..");
const uiSrc = join(repoRoot, "packages/ui/src");
const sharedSrc = join(repoRoot, "packages/shared/src");
const servicesSrc = join(repoRoot, "packages/services/src");

const DATA_SYNC_NODE = join(servicesSrc, "data-sync/node.ts");

function dataUrl(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

// mcpSyncService 只把 createMcpDataSyncMethods 当作 IMcpSyncService 继承来的附带能力；
// load/save/listWorkspaceMcpServerStatuses 全部来自 mcpSyncService 自身，故这里返回空对象即可。
const DATA_SYNC_NODE_SHIM = dataUrl("export function createMcpDataSyncMethods() { return {}; }\n");

// @zcode/shared 的 barrel 会连锁加载上百个模块（zod schema、协议、web-remote-relay 等），
// 与本路由无关。这里按需 re-export 被测模块真正用到的真实实现，不是另写一份逻辑。
const SHARED_SHIM = dataUrl(
  [
    `export { convertToZCodeAgentMcpServer } from ${JSON.stringify(pathToFileURL(join(sharedSrc, "mcp.ts")).href)};`,
    `export { formatLogPrefix } from ${JSON.stringify(pathToFileURL(join(sharedSrc, "log-format.ts")).href)};`,
    `export { isPublicZCodeErrorCode } from ${JSON.stringify(pathToFileURL(join(sharedSrc, "source-server/errorCodes.ts")).href)};`,
    `export { resolveZCodeRuntimeEnv } from ${JSON.stringify(pathToFileURL(join(sharedSrc, "runtimeEnv.ts")).href)};`,
    "",
  ].join("\n"),
);

// NodeNext ESM 源码里写的是 `.js` 后缀（对应编译产物），仓库里实际是 `.ts`。
function resolveTsCandidate(absPath) {
  if (existsSync(absPath)) {
    return absPath;
  }
  if (absPath.endsWith(".js")) {
    const tsPath = `${absPath.slice(0, -3)}.ts`;
    if (existsSync(tsPath)) {
      return tsPath;
    }
  }
  return null;
}

// 源码写 `.js` 后缀、仓库里实际是 `.ts`；这里在交给 Node 默认解析前统一回退。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@zcode/shared") {
    return { url: SHARED_SHIM, format: "module", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const mapped = resolveTsCandidate(join(uiSrc, specifier.slice(2)));
    if (mapped) {
      return { url: pathToFileURL(mapped).href, shortCircuit: true };
    }
  }
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    const absolute = specifier.startsWith("/")
      ? specifier
      : resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    const mapped = resolveTsCandidate(absolute);
    if (mapped === DATA_SYNC_NODE) {
      return { url: DATA_SYNC_NODE_SHIM, format: "module", shortCircuit: true };
    }
    if (mapped) {
      return { url: pathToFileURL(mapped).href, shortCircuit: true };
    }
  }
  if (specifier.startsWith("#src/")) {
    // 本图里只有 services 用到 `#src/*`；依次尝试三个包目录，命中即可。
    const rest = specifier.slice("#src/".length);
    for (const base of [servicesSrc, sharedSrc, uiSrc]) {
      const mapped = resolveTsCandidate(join(base, rest));
      if (mapped) {
        return { url: pathToFileURL(mapped).href, shortCircuit: true };
      }
    }
  }
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("file:") && result.url.endsWith(".js")) {
    const absolute = fileURLToPath(result.url);
    if (!existsSync(absolute) && existsSync(`${absolute.slice(0, -3)}.ts`)) {
      return { url: pathToFileURL(`${absolute.slice(0, -3)}.ts`).href, shortCircuit: true };
    }
  }
  return result;
}
