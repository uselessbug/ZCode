import type { ZCodeInteractionRequestOrigin } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: ZCodeInteractionRequestOrigin;
}) {
  const { intl } = useZCodeIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  // description 点名是哪个子代理在问（动态工作流子代理为 `<名字> (<siteId>@<ordinal>)`，
  // docs/dynamic-workflow/launch.md「Permissions inside a run」）；权限来源必须直接完整可读，不能依赖桌面 hover 或在手机上截断。
  const description = origin.description?.trim();
  const label = description
    ? intl.formatMessage({ id: "chat.interactionOrigin.subagent.named" }, { description })
    : intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  const title = !origin.agentType
    ? label
    : description
      ? intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.titleNamed" },
          { agentType: origin.agentType, description },
        )
      : intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.title" },
          { agentType: origin.agentType },
        );

  return (
    <Badge
      variant="outline"
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn(
        "h-auto min-h-5 max-w-full min-w-0 shrink justify-start overflow-visible rounded-lg py-1 text-left align-baseline text-ui-base leading-5 whitespace-normal break-words [overflow-wrap:anywhere]",
        className,
      )}
    >
      {title}
    </Badge>
  );
}
