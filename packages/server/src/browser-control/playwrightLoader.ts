import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaywrightChromiumModule } from "@zcode/adapters/browser";

export interface ServerPlaywrightLoaderOptions {
  /** 可选入口文件 URL（默认当前模块 URL），用于定位同级 ../agent/zcode.cjs。 */
  entryUrl?: string;
  existsSync?: (path: string) => boolean;
}

export function resolvePackagedAgentEntryPath(entryUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(entryUrl)), "../agent/zcode.cjs");
}

/**
 * 发行包布局下经 ../agent/zcode.cjs 的 createRequire 加载已 stage 的 agent/node_modules/playwright-core；
 * 源码开发模式下直接从包声明依赖加载，不扫描用户目录。
 */
export async function loadServerPlaywrightChromium(
  options: ServerPlaywrightLoaderOptions = {},
): Promise<PlaywrightChromiumModule> {
  const checkExists = options.existsSync ?? existsSync;
  const agentEntryPath = resolvePackagedAgentEntryPath(options.entryUrl);
  if (checkExists(agentEntryPath)) {
    const agentRequire = createRequire(agentEntryPath);
    return agentRequire("playwright-core") as PlaywrightChromiumModule;
  }
  return (await import("playwright-core")) as PlaywrightChromiumModule;
}
