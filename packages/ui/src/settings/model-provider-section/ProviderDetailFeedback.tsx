import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2Icon, CircleAlertIcon, LoaderCircle, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export type ProviderDetailFeedbackState = "pending" | "success" | "failure";

export interface ProviderDetailFeedbackInput {
  key: string;
  /**
   * beginOperation(key) 返回的操作实例号。带实例号的反馈只有在它仍是该 key 的最新实例时才会落地；
   * 不带实例号的反馈（如连接测试）始终直接替换。
   */
  operationId?: number;
  message: string;
  state: ProviderDetailFeedbackState;
  /** 连接测试成功使用语义绿；保存/删除沿用中性反馈，不按文案或 key 推断操作。 */
  successEmphasis?: boolean;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
}

interface ProviderDetailFeedbackContextValue {
  /** 为通知 key 登记新的操作实例并返回实例号；同 key 较早实例此后的反馈会被丢弃。 */
  beginOperation: (key: string) => number;
  showFeedback: (input: ProviderDetailFeedbackInput) => void;
  dismissFeedback: (key: string) => void;
}

const ProviderDetailFeedbackContext = createContext<ProviderDetailFeedbackContextValue>({
  beginOperation: () => 0,
  showFeedback: () => undefined,
  dismissFeedback: () => undefined,
});

export function useProviderDetailFeedback(): ProviderDetailFeedbackContextValue {
  return useContext(ProviderDetailFeedbackContext);
}

function resolveDefaultDuration(state: ProviderDetailFeedbackState): number {
  if (state === "pending") return 0;
  return state === "failure" ? 8_000 : 3_500;
}

export function ProviderDetailFeedbackBoundary({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ProviderDetailFeedbackInput[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // 修复原因：旧实现让组件内单个 draftRevision 同时充当所有操作的“最新”判据，
  // 不同模型的并发删除/保存、或模型操作在途时编辑草稿，都会让较早操作的完成被误判为过期，
  // 对应 pending 通知永远不会被替换。反馈所有权改为“通知 key -> 该 key 最新操作实例”，
  // 由这里唯一持有，Provider 切换/重挂载后的卡片实例共享同一份，不会出现多个 owner。
  const latestOperationRef = useRef(new Map<string, number>());
  const operationSequenceRef = useRef(0);

  const beginOperation = useCallback((key: string) => {
    const operationId = operationSequenceRef.current + 1;
    operationSequenceRef.current = operationId;
    latestOperationRef.current.set(key, operationId);
    return operationId;
  }, []);

  const dismissFeedback = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(key);
    setItems((current) => current.filter((item) => item.key !== key));
  }, []);

  const showFeedback = useCallback(
    (input: ProviderDetailFeedbackInput) => {
      if (
        input.operationId !== undefined &&
        latestOperationRef.current.get(input.key) !== input.operationId
      ) {
        // 同 key 已有更新的操作实例：旧实例的 pending/success/failure 都不得覆盖它。
        return;
      }
      const previousTimer = timersRef.current.get(input.key);
      if (previousTimer) clearTimeout(previousTimer);
      timersRef.current.delete(input.key);
      setItems((current) => {
        const existingIndex = current.findIndex((item) => item.key === input.key);
        if (existingIndex < 0) return [...current, input];
        const next = [...current];
        next[existingIndex] = input;
        return next;
      });

      const durationMs = input.durationMs ?? resolveDefaultDuration(input.state);
      if (durationMs > 0) {
        timersRef.current.set(
          input.key,
          setTimeout(() => dismissFeedback(input.key), durationMs),
        );
      }
    },
    [dismissFeedback],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const contextValue = useMemo(
    () => ({ beginOperation, showFeedback, dismissFeedback }),
    [beginOperation, dismissFeedback, showFeedback],
  );

  return (
    <ProviderDetailFeedbackContext.Provider value={contextValue}>
      {children}
      {/* 整页滚动后，内容底部可能在屏外；覆盖层不占高度，sticky 以 main 视口定位反馈。 */}
      <div className="pointer-events-none absolute inset-3 flex flex-col justify-end sm:inset-4">
        <div
          className="sticky bottom-3 z-20 flex flex-col gap-2 sm:bottom-4"
          data-testid="provider-detail-feedback-viewport"
          aria-live="polite"
        >
          {items.map((item) => (
            <div
              key={item.key}
              role={item.state === "failure" ? "alert" : "status"}
              data-provider-detail-feedback-state={item.state}
              className={cn(
                "pointer-events-auto flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2.5 backdrop-blur-sm",
                item.state === "success" &&
                  (item.successEmphasis
                    ? "border-success/30 bg-success/10 text-success shadow-md"
                    : "border-border bg-popover/95 text-foreground shadow-md"),
                item.state === "failure" &&
                  "border-destructive/30 bg-destructive/10 text-destructive shadow-lg",
                item.state === "pending" && "border-border bg-popover/95 text-foreground shadow-md",
              )}
            >
              {item.state === "pending" ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : item.state === "success" ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 text-ui-sm font-medium">{item.message}</span>
              {item.actionLabel && item.onAction ? (
                <Button type="button" variant="ghost" size="sm" onClick={item.onAction}>
                  {item.actionLabel}
                </Button>
              ) : null}
              {item.dismissible ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={item.dismissLabel ?? item.message}
                  onClick={() => dismissFeedback(item.key)}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </ProviderDetailFeedbackContext.Provider>
  );
}
