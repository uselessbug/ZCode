/**
 * server-browser-control 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const serverBrowserControlModule = {
  id: "server-browser-control",
  requires: ["services", "shared", "zcode-cli"],
  provides: ["server-browser-control"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
