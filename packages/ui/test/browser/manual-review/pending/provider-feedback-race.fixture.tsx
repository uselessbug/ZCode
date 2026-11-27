import { useState } from "react";
import { createRoot } from "react-dom/client";
import { parseZCodeBuiltinModelConfigRules } from "@zcode/provider";
import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import release from "../../../../../../config/provider/zcode-builtin.json";
import "@/styles.css";

/**
 * Provider 详情反馈竞态回归 fixture。
 *
 * 与 provider-settings-batch.fixture 的区别：这里所有写请求都不自动完成，而是登记到
 * window.zcodeRace.calls，由测试决定“哪一个请求、以什么结果、按什么顺序”完成。
 * 这样可以确定性构造多请求交错，而不依赖网络延时或固定 sleep。
 * 渲染的仍是真实 InlineEditableProviderCard + ProviderDetailFeedbackBoundary。
 */
const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
const templates = release.config.providerConfigRules
  .templateRules as ProviderSettingsView["providerTemplates"];
const CUSTOM_MODEL_IDS = ["custom-a", "custom-b"];

function createProvider(): ProviderSettingsFormProvider {
  const templateId = "bigmodel-api";
  const template = templates.find((t) => t.templateId === templateId)!;
  const config: ProviderSettingsFormProvider["config"] = {
    ...template.config,
    group: "standard-personal" as const,
    access: { ...template.config.access, apiKey: "fixture-key" },
  };
  return {
    providerId: "fixture",
    providerName: "Fixture Provider",
    templateId,
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: {},
    config,
    models: [...config.builtinModelIds!, ...CUSTOM_MODEL_IDS].map((modelId) => ({
      kind: "candidate",
      modelId,
      builtin: !CUSTOM_MODEL_IDS.includes(modelId),
      config: rules
        .resolve({
          providerId: "fixture",
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        })
        .toJSON(),
      personalConfig: {},
      hasPersonalConfig: CUSTOM_MODEL_IDS.includes(modelId),
      executable: true,
      selectable: true,
    })),
  };
}

interface RaceCall {
  id: number;
  action: string;
  modelId?: string;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}
interface RaceHandle {
  calls: RaceCall[];
  /** 完成第 nth 个尚未完成、且匹配 action/modelId 的请求。找不到时抛错，避免测试静默空转。 */
  settle(match: { action: string; modelId?: string; nth?: number; ok: boolean }): number;
}
declare global {
  interface Window {
    zcodeRace: RaceHandle;
  }
}

const calls: RaceCall[] = [];
window.zcodeRace = {
  calls,
  settle({ action, modelId, nth = 0, ok }) {
    const candidates = calls.filter(
      (call) => !call.settled && call.action === action && call.modelId === modelId,
    );
    const target = candidates[nth];
    if (!target) throw new Error(`no pending call ${action}/${modelId}#${nth}`);
    target.settled = true;
    if (ok) target.resolve();
    else target.reject(new Error("fixture rejected"));
    return target.id;
  },
};

function track(action: string, modelId?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    calls.push({ id: calls.length, action, modelId, settled: false, resolve, reject });
  });
}

function Fixture() {
  const [provider, setProvider] = useState(createProvider);
  // 递增即卸载并重挂载卡片，复现“切换 Provider 后再切回”时 Boundary 不变、卡片实例更换。
  const [instance, setInstance] = useState(0);
  return (
    <main className="relative min-h-screen bg-background p-4 text-foreground">
      {/* 通知层是 sticky 贴在视口底部的覆盖层；真实设置页是长滚动页，用户点击时行在视口上半部。
            fixture 只有一屏，因此用大 pb 撑出滚动高度，由测试把模型行滚到视口上方再原生 click。 */}
      <button type="button" data-testid="race-remount" onClick={() => setInstance((n) => n + 1)}>
        remount
      </button>
      <section className="relative min-w-0" style={{ paddingBottom: "60rem" }} data-testid="detail">
        <ProviderDetailFeedbackBoundary>
          <InlineEditableProviderCard
            key={instance}
            provider={provider}
            onSave={async (next) => {
              await track("save");
              setProvider((p) => ({
                ...p,
                providerName:
                  next.providerNameUpdate === undefined ? p.providerName : next.providerNameUpdate,
                config: next.config,
                personalConfig: next.personalConfig,
              }));
            }}
            onDeletePersonalModel={async (_providerId, modelId) => {
              await track("delete", modelId);
              setProvider((p) => ({ ...p, models: p.models.filter((m) => m.modelId !== modelId) }));
            }}
            onSetPersonalModelEnabled={async (_providerId, modelId, enabled) => {
              await track("enable", modelId);
              setProvider((p) => ({
                ...p,
                models: p.models.map((m) =>
                  m.modelId === modelId ? { ...m, config: { ...m.config, enabled } } : m,
                ),
              }));
            }}
            onTestModel={async () => ({ success: true })}
          />
        </ProviderDetailFeedbackBoundary>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider
    services={
      {
        providerSettingsService: {
          resolveModelConfig: async () => {
            throw new Error("not used by the race fixture");
          },
        },
      } as unknown as IServiceAccessor
    }
  >
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <Fixture />
      </ZCodeIntlProvider>
    </TooltipProvider>
  </ServiceProvider>,
);
