import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "@zcode/services";
import { Copy, Pencil, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { logger } from "@/logger.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import {
  TID_SETTINGS_MEMORY_CANCEL,
  TID_SETTINGS_MEMORY_CONFLICT,
  TID_SETTINGS_MEMORY_CONTENT,
  TID_SETTINGS_MEMORY_COPY_PATH,
  TID_SETTINGS_MEMORY_EDIT,
  TID_SETTINGS_MEMORY_PREVIEW,
  TID_SETTINGS_MEMORY_SAVE,
  TID_SETTINGS_MEMORY_VIEWER_DIALOG,
} from "@zcode/shared/test-ids";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IMemoryService, ProjectMemoryWorkspaceSummary } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_OPEN,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_WORKSPACE,
  testId,
} from "@zcode/shared/test-ids";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

export type MemoryViewerLoadingState = "idle" | "loading" | "ready" | "error";

type MemoryFileService = Pick<IMemoryService, "readProjectMemoryFile" | "saveProjectMemoryFile">;

export function MemorySettingsViewer({
  catalogError,
  catalogState,
  selectedWorkspace,
  workspaces,
  memoryService,
  onRefresh,
  onScopeKeyChange,
}: {
  catalogError: string | null;
  catalogState: MemoryViewerLoadingState;
  selectedWorkspace: ProjectMemoryWorkspaceSummary | undefined;
  workspaces: ProjectMemoryWorkspaceSummary[];
  memoryService: MemoryFileService;
  onRefresh: () => Promise<void>;
  onScopeKeyChange: (workspaceId: string) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [searchQuery, setSearchQuery] = useState("");
  // 打开时刻即固定 workspaceId：selectedWorkspace 之后被切换时，弹窗仍用旧 filename 对应的旧 scope，
  // 不会拿旧文件名去新 workspace 重新请求。
  const [openedFile, setOpenedFile] = useState<{
    name: string;
    path: string;
    workspaceId: string;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const formatMemoryCount = (count: number) =>
    intl.formatMessage(
      {
        id: `settings.memory.viewer.memoryCount.${count === 1 ? "one" : "other"}`,
      },
      { count },
    );
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      selectedWorkspace?.files.filter((file) =>
        file.name.toLocaleLowerCase().includes(normalizedSearchQuery),
      ) ?? [],
    [normalizedSearchQuery, selectedWorkspace],
  );

  if (catalogError) {
    return (
      <Alert>
        <AlertDescription>{catalogError}</AlertDescription>
      </Alert>
    );
  }

  if (catalogState === "loading" && workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
      </div>
    );
  }

  if (!selectedWorkspace) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.empty" })}
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginScopeMenu
            includeUser={false}
            selectedScopeKey={selectedWorkspace.id}
            workspaceOptions={workspaces.map((workspace) => ({
              key: workspace.id,
              label: workspace.label,
            }))}
            onScopeKeyChange={onScopeKeyChange}
            triggerIconTestId={TID_SETTINGS_MEMORY_SCOPE_ICON}
            triggerTestId={TID_SETTINGS_MEMORY_SCOPE_TRIGGER}
            workspaceOptionTestIdPrefix={TID_SETTINGS_MEMORY_WORKSPACE}
          />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <span
            data-testid={TID_SETTINGS_MEMORY_COUNT}
            className="shrink-0 text-ui-sm text-foreground-subtle"
          >
            {formatMemoryCount(selectedWorkspace.files.length)}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <SettingsSearchInput
            containerClassName="w-full sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={TID_SETTINGS_MEMORY_SEARCH_CLEAR}
            data-testid={TID_SETTINGS_MEMORY_SEARCH_INPUT}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.memory.viewer.searchPlaceholder",
            })}
          />
        </div>
      </div>

      {normalizedSearchQuery && visibleFiles.length === 0 ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.memory.viewer.searchEmpty",
          })}
        />
      ) : (
        <>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.memory.viewer.files" })}
            </h3>
            <SettingsResourceHeaderActions
              onRefresh={() => void onRefresh()}
              refreshing={catalogState === "loading"}
              refreshTestId={TID_SETTINGS_MEMORY_REFRESH}
              refreshLabel={intl.formatMessage({
                id: "settings.memory.viewer.refresh",
              })}
            />
          </div>
          <div className="overflow-hidden rounded-xl bg-surface">
            {visibleFiles.map((file, index) => (
              <Fragment key={file.name}>
                {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                <div
                  data-testid={testId(TID_SETTINGS_MEMORY_FILE, file.name)}
                  className="flex min-w-0 items-center hover:bg-hover"
                >
                  <button
                    type="button"
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE_OPEN, file.name)}
                    aria-label={intl.formatMessage({ id: "settings.memory.viewer.openFile" })}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-3 text-left"
                    onClick={() =>
                      setOpenedFile({
                        name: file.name,
                        path: file.path,
                        workspaceId: selectedWorkspace.id,
                      })
                    }
                  >
                    <span
                      data-testid={testId(TID_SETTINGS_MEMORY_FILE_ICON, file.name)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background"
                    >
                      <FileDisplayIcon
                        src={resolveFileDisplayDescriptor(file.path).fileIconSrc}
                        size={16}
                        className="size-4 shrink-0"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_NAME, file.name)}
                        className="block truncate text-ui-base font-medium text-foreground"
                      >
                        {file.name}
                      </span>
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, file.name)}
                        className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
                      >
                        {formatMemoryUpdatedAt({
                          formatMessage: intl.formatMessage,
                          locale,
                          now,
                          updatedAt: file.updatedAt,
                        })}
                      </span>
                    </span>
                  </button>
                  <span
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, file.name)}
                    className="mr-3 flex shrink-0 items-center gap-2"
                  >
                    {/* 桌面端保留既有外部编辑器入口；独立 Web 下该组件自身返回 null，由页内查看入口取代。 */}
                    <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} />
                  </span>
                </div>
              </Fragment>
            ))}
          </div>
        </>
      )}

      {openedFile ? (
        <MemoryFileViewerDialog
          // key 固定为 workspace+file：workspace 切换时重置弹窗状态，避免旧文件名落到新 scope。
          key={`${openedFile.workspaceId}:${openedFile.name}`}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setOpenedFile(null);
          }}
          workspaceId={openedFile.workspaceId}
          fileName={openedFile.name}
          filePath={openedFile.path}
          memoryService={memoryService}
          onSaved={onRefresh}
        />
      ) : null}
    </section>
  );
}

function readErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MemoryFileViewerDialog({
  open,
  onOpenChange,
  workspaceId,
  fileName,
  filePath,
  memoryService,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  fileName: string;
  filePath: string;
  memoryService: MemoryFileService;
  onSaved: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const fileActions = useFileContextActions();
  const requestIdRef = useRef(0);
  // Service 可能在 base host 换代时改变引用；正文读取只应在“打开文件/切换文件”时触发，
  // 不能因为 service 引用变化而反复重新拉取。这里用 ref 取最新 service，effect 只依赖文件名。
  const memoryServiceRef = useRef(memoryService);
  memoryServiceRef.current = memoryService;
  const [loading, setLoading] = useState(false);
  // 只存错误码，文案在渲染期用当前 intl 生成：语言切换时错误提示会跟着更新，
  // 而读取本身不再依赖 intl，不会因语言变化重拉文件而抹掉草稿。
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loaded, setLoaded] = useState<{
    content: string;
    updatedAt: number;
    contentHash: string;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const dirty = editing && loaded !== null && draft !== loaded.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const loadFile = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setLoadErrorCode(null);
    setConflict(false);
    setEditing(false);
    setSaving(false);
    try {
      const result = await memoryServiceRef.current.readProjectMemoryFile({
        workspaceId,
        fileName,
      });
      if (requestIdRef.current !== requestId) return;
      setLoaded(result);
      setDraft(result.content);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoaded(null);
      setLoadErrorCode(readErrorCode(error) ?? "unknown-error");
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [fileName, workspaceId]);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      setLoaded(null);
      setDraft("");
      setLoadErrorCode(null);
      setConflict(false);
      setEditing(false);
      return;
    }
    void loadFile();
    return () => {
      requestIdRef.current += 1;
    };
  }, [open, loadFile]);

  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current) return true;
    const requestId = requestIdRef.current;
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "settings.memory.viewer.discardConfirmTitle" }),
      description: intl.formatMessage({ id: "settings.memory.viewer.discardConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "settings.memory.viewer.discardConfirm" }),
      confirmVariant: "destructive",
    });
    return confirmed && requestIdRef.current === requestId;
  }, [intl, requestConfirmation]);

  // 关闭和重新加载共用草稿确认；保存中保留当前文件，防止旧结果落入下一份正文。
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (saving) return;
      if (nextOpen) {
        onOpenChange(true);
        return;
      }
      void confirmDiscard().then((confirmed) => {
        if (confirmed) onOpenChange(false);
      });
    },
    [confirmDiscard, onOpenChange, saving],
  );

  const handleSave = useCallback(async () => {
    // 冲突后必须先重新加载拿到新版本，重复用旧版本保存没有意义。
    if (!loaded || saving || conflict) return;
    const requestId = requestIdRef.current;
    setSaving(true);
    try {
      const saved = await memoryServiceRef.current.saveProjectMemoryFile({
        workspaceId,
        fileName,
        content: draft,
        // 乐观并发：用读取时刻的 mtime + 内容 hash 作为期望版本；服务端不符即拒绝覆盖。
        expectedUpdatedAt: loaded.updatedAt,
        expectedContentHash: loaded.contentHash,
      });
      if (requestIdRef.current !== requestId) return;
      setLoaded({ content: draft, ...saved });
      setEditing(false);
      await onSaved();
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      const code = readErrorCode(error);
      if (code === PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE) {
        // 文件在别处被改动/删除/替换：不覆盖，保留草稿，等待用户重新加载后再保存。
        setConflict(true);
      } else {
        logger.warn("[MemoryFileViewer] 保存项目记忆失败", {
          fileName,
          error: getErrorMessage(error),
        });
        toast(
          intl.formatMessage(
            { id: "settings.memory.viewer.saveFailed" },
            { error: getErrorMessage(error) },
          ),
        );
      }
    } finally {
      if (requestIdRef.current === requestId) setSaving(false);
    }
  }, [conflict, draft, fileName, intl, loaded, onSaved, saving, workspaceId]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[min(42rem,calc(100dvh-4rem))] w-[min(52rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)]"
        data-testid={TID_SETTINGS_MEMORY_VIEWER_DIALOG}
      >
        <DialogTitle className="truncate pr-8 font-mono text-ui-base">{fileName}</DialogTitle>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            data-testid={testId(TID_SETTINGS_MEMORY_COPY_PATH, fileName)}
            onClick={() => {
              void fileActions.copyPath({ path: filePath });
              toast(intl.formatMessage({ id: "settings.memory.viewer.pathCopied" }));
            }}
          >
            <Copy data-icon="inline-start" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.memory.viewer.copyPath" })}
          </Button>
          {conflict ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              data-testid={TID_SETTINGS_MEMORY_REFRESH}
              disabled={saving || loading}
              onClick={() => {
                void confirmDiscard().then((confirmed) => {
                  if (confirmed) void loadFile();
                });
              }}
            >
              <RotateCw data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.memory.viewer.reload" })}
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={saving || !loaded || conflict}
                data-testid={TID_SETTINGS_MEMORY_SAVE}
                onClick={() => void handleSave()}
              >
                {saving
                  ? intl.formatMessage({ id: "settings.memory.viewer.saving" })
                  : intl.formatMessage({ id: "settings.memory.viewer.save" })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                data-testid={TID_SETTINGS_MEMORY_CANCEL}
                onClick={() => {
                  setDraft(loaded?.content ?? "");
                  setEditing(false);
                  setConflict(false);
                }}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!loaded}
              data-testid={TID_SETTINGS_MEMORY_EDIT}
              onClick={() => setEditing(true)}
            >
              <Pencil data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.memory.viewer.edit" })}
            </Button>
          )}
        </div>

        <div className="min-h-0 overflow-hidden rounded-xl border border-border bg-background">
          {conflict ? (
            <div className="p-3" data-testid={TID_SETTINGS_MEMORY_CONFLICT}>
              <Alert>
                <AlertDescription>
                  {intl.formatMessage({ id: "settings.memory.viewer.saveConflict" })}
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          {loadErrorCode !== null ? (
            <div className="p-4 text-ui-base text-foreground-subtle">
              {loadErrorCode === PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE
                ? intl.formatMessage({ id: "settings.memory.viewer.fileTooLarge" })
                : loadErrorCode === PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE
                  ? intl.formatMessage({ id: "settings.memory.viewer.fileChanged" })
                  : intl.formatMessage({ id: "settings.memory.viewer.fileDeleted" })}
            </div>
          ) : loading ? (
            <div className="p-4 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.memory.viewer.fileLoading" })}
            </div>
          ) : editing ? (
            <Textarea
              autoFocus
              spellCheck={false}
              data-testid={TID_SETTINGS_MEMORY_CONTENT}
              className="h-full min-h-96 rounded-lg border-0 bg-transparent font-mono max-md:text-mobile-input-safe"
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <div className="h-full min-h-96" data-testid={TID_SETTINGS_MEMORY_PREVIEW}>
              <MarkdownPreviewContent content={loaded?.content ?? ""} sourceTitle={fileName} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
