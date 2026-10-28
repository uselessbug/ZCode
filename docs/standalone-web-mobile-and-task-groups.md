# 独立云端 Web：任务分组登记与手机界面兼容（第二轮）

适用范围：3.16.2-oci.3 起，在 3.16.2-oci.2 连接恢复补丁与第一轮「任务管理 / 项目模式兼容」
补丁**之后**应用。两者都保持完好，本补丁只做增量修复。

上游固定提交：`zai-org/ZCode 3c5b227649371507ddc4eb46ac5133afe6db1cab`（package 3.16.2）。

## 1. 分组登记错误（task-groups owner 与 identity 贯通）

### 1.1 根因

独立云端 Web 的 owner Host 是 `remote:server:<id>`，而前端在缺少 `workspaceIdentity`
时会回落到 `hostId: "local"`。旧实现在三处把请求侧身份当权威：

1. `createTaskGroupService` 的 `taskSchema` 写死只认 `"local"`，`hostId: "local"` 配
   owner 作用域的 server identity 直接被 `task-group.host-identity-mismatch` 拒绝。
2. `resolveTasks` 按请求侧 `hostId` 读目录，`"local"` 会走到未连接的 Host，抛
   `project.host-offline`。
3. `move` / `admit` 把请求侧 ref 原样交给仓储，仓储用 `resolveWorkspaceKey(ref)`
   计算 `workspace_key`，而 `admit` 写入的是 Host 返回的权威 identity。两套键分叉后
   `nodeKey`、`this.parent`、`anchor` 查找全部落空（表现为拖动排序丢失、移出分组无效）。

### 1.2 修复

- `packages/services/src/task-groups/index.ts`
  - 新增并导出 `resolveTaskGroupOwnerHostId(hostId, ownerHostId, allowStandaloneLocalHostAlias)`：
    只在装配层显式开启别名、且 owner 非 `local` 时，把 `"local"` 解析到 owner。
  - 新增并导出 `isTaskGroupHostIdentityConsistent(task, ownerHostId, allowStandaloneLocalHostAlias)`：
    校验 ref 的 `hostId` 与 `workspaceIdentity` 指向同一权威 Host。
  - `createTaskGroupService` 新增可选 `ownerHostId` / `allowStandaloneLocalHostAlias`；
    schema 在工厂内按这两个选项构造，不满足一致性仍报 `task-group.host-identity-mismatch`。
  - 工厂内新增 `matchesTaskFact(fact, ref)`：比较 `taskId` + `workspacePath` + 解析后的
    owner Host + `groupTaskKey`；在别名开启时额外接受「一方只有路径 key、另一方是
    owner 作用域下同路径 server identity」。
  - `move`：用 `matchesTaskFact` 在 Host 事实里定位权威 fact（`deleted`/`archived`
    仍报 `task-group.task-unavailable`），并把 `node.task` / `anchor.node.task`
    **归一化为该 fact** 后再交给仓储，保证写入键与 `admit` 登记的键逐字一致。
  - `admit`：`placement` 用 `matchesTaskFact` 定位非删除 fact（否则
    `task-group.created-task-unavailable`），把 `{ ...placement, task: placementFact }`
    传给仓储。

- `packages/services/src/node.ts`
  - 装配 `createTaskGroupService` 时传入 `ownerHostId: options?.projectStorageHostId` 与
    `allowStandaloneLocalHostAlias: Boolean(options?.allowStandaloneCloudWorkspaces)`。
  - `resolveTasks` 按解析后的 owner Host 去重读取目录；匹配顺序为 `groupTaskKey(ref)`
    → 别名下 `taskId + workspacePath`；校验 `ownerHostId(fact.hostId) === targetHostId`
    与 `fact.workspacePath === ref.workspacePath`；只回传 `{ ...fact, deleted: Boolean(fact.deleted) }`，
    **不再用请求侧的 `hostId` / 非权威 `workspaceIdentity` 覆盖存储键**。

- `packages/services/src/project/index.ts`（`bindRemoteProjectIdentities.readTree`）
  - `paths` 纳入 `tree.deletedTasks` 的 `workspacePath`，并在返回对象里同样映射
    `deletedTasks` 的 `workspaceIdentity`。删除事实与活动任务共用同一个身份键，
    否则墓碑键与 `admit` 写入的 `workspace_key` 分叉。

- `packages/services/src/project-storage/project-repository.ts`（`readTree.deletedTasks`）
  - 与 `readTasks` 同源：SELECT 增加 `workspace_key`；`workspace_identity` 非空则取之，
    否则当 `isRemoteWorkspaceIdentity(workspace_key)` 为真时取 `workspace_key`。

## 2. 独立云端 Web 手机界面

不伪造 `webRemoteControlWorkspaceSwitcher`；复用既有 `WebRemoteControlMobileShell`。

- `packages/ui/src/WebRemoteControlMobileShell.tsx`：`switcher` 改为可选
  （`WebRemoteControlTaskViewReporter` 的 `switcher` 本就是可选）。
- `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
  - `isWebRemoteControlShell = Boolean(webRemoteControlWorkspaceSwitcher)` 保持不变，
    继续用于远控专属 relay/switcher 逻辑。
  - 新增 `isMobileWorkspaceShellActive = isWebRemoteControlShell || (!isDesktop && isWebRemoteControlMobileViewport)`
    与等价的 `isCompactMobileWorkspace`。
  - `(max-width: 767px)` 的 `matchMedia` 监听从 `!isWebRemoteControlShell` 放宽为
    `(isDesktop && !isWebRemoteControlShell)`：所有非桌面 Web 都实时响应视口变化；
    桌面端行为 100% 不变（既有 `workspaceShellRemoteMobileLayout.test.ts` 依赖的
    默认 `matchMedia` 未匹配行为不变）。
  - `renderRemoteShell` 与根返回改为 `isMobileWorkspaceShellActive` 判定，并把
    `switcher={webRemoteControlWorkspaceSwitcher}` 原样传入。
  - 手机 Home 导航（仅 `mobile && !isWebRemoteControlShell`）：`onSelectTask` /
    `onStartDraftInWorkspace` / `onCreateTask` / `onCreateConversationTask` /
    `onOpenAutomations` / `onOpenPluginStore` 在调用原 handler 后 `mobile.navigateToChat()`。
  - 草稿头部 `ProjectComposerMenu` / `GitBranchSwitcher` 的
    `compactForRemoteControl` 改用 `isCompactMobileWorkspace`。
- 窄屏防溢出：
  - `project-sidebar/index.tsx`：顶部 48px 拖拽留白在 `isWebRemoteControl || !isDesktop`
    时 `max-md:hidden`。
  - `SessionPane.tsx`：两处 `min-w-0` 改为 `(compactForRemoteControl || !isDesktop)`；
    传给 `ConversationComposer` / `ConversationStatusPanel` 的 `isWebRemoteControl`
    改为 `compactForRemoteControl || !isDesktop`（等价于「独立 Web 复用手机输入控件行为」，
    不新增 props）。
  - `ConversationTimeline.tsx`：两处 `min-w-0` 无条件启用。
  - `V4ComposerToolbar.tsx`：`providerSubmenuClassName` 改为 `isMobileViewport ? ...`。
  - `ProjectSidebarNavigation.tsx` 保持不变：独立 Web 无外层覆盖按钮，也不需要 `pt-11`。

## 3. 回归测试

`deploy/standaloneWebMobileAndTaskGroups.test.mjs`（`node --test`，无第三方依赖）：

- Area A（编译真实 `task-groups` 服务 + 仓储，跑真实 in-memory SQLite）：
  1. 别名下 `hostId: "local"` 自动 `admit` 成功，存储键为 owner identity。
  2. `placement`（默认 `null` 与指定分组）的 `members`/`order` 与 `read()` 一致。
  3. 建组 / 移入 / 带 anchor 排序 / 移出 / `ungroup` / 重连后 `read()` 一致。
  4. 跨 Host 隔离：未连接 Host 报 `project.host-offline`；伪造 `hostId: "local"` 配异主
     identity 报 `task-group.host-identity-mismatch`；仅存在于其它 Host 的任务报
     `task-group.task-unavailable`。
  5. 只有路径 key 的请求侧 ref 仍能匹配 owner 作用域 identity。
  6. 删除任务不可 placement / 不可 move，且保留墓碑。
  7. `SessionPane` 的重试闭包只重试 `taskGroupService.admit`，不调用 `createSession`。
- Area C（删除事实身份贯通）：`bindRemoteProjectIdentities` 解析 `deletedTasks` 身份；
  `ProjectRepository.readTree.deletedTasks` 的 `workspaceIdentity` 与活动键同源。
- Area B（独立 Web 手机壳层源码契约）：`isMobileWorkspaceShellActive` 判定与
  `matchMedia` 门禁；手机 Home 各入口 `navigateToChat`；`WebRemoteControlMobileShell`
  的可选 switcher / popstate / 历史恢复 / 右侧覆盖抽屉 + `inert`；窄屏 `min-w-0`
  与移动视口菜单宽度。

## 4. 边界

- 不改 `/app/zcode` 运行时与 `/home/agent/.zcode` 真实用户数据库。
- 不为分组建立连接或启动 Agent；`resolveTasks` 只读所属 Host 的权威目录。
- 不改变仓储归属与鉴权；别名只在装配层显式开启时生效。
- 不静默更换模型/供应商。

## 5. 第二阶段补充（窄屏与断点切换细节）

- `WorkspaceShellLayout`：`isMobileWorkspaceShellActive = isWebRemoteControlShell || !isDesktop`
  （非桌面一律常驻手机壳层）。`WebRemoteControlMobileShell` 在 `!isMobileViewport` 时内部
  直接渲染 `children`(wideContent)，因此常驻挂载保证手机横竖屏（390px <-> 844px）切换时
  不卸载组件、不丢 `currentPage === "chat"`。紧凑宽度改用独立变量
  `isCompactMobileWorkspace = isWebRemoteControlShell || (!isDesktop && isWebRemoteControlMobileViewport)`。
- `ConversationComposer`：引入 `useIsMobileCompactViewport`，
  `compactMobilePlaceholder = isWebRemoteControl && (isMobileTextInputViewport || isMobileCompactViewport)`，
  360/390/412px 窄屏（无论是否 coarse 指针）都显示短占位符，不三行溢出遮挡工具栏。
- `SessionPane`：引入 `useIsMobileCompactViewport`；
  `ConversationStatusPanel.isMobileViewport = isMobileTextInputViewport || isMobileCompactViewport`；
  `ConversationDraftEmptyState.compactForRemoteControl` 与 `compactEmptyStateWithDock`
  改为 `compactForRemoteControl || (!isDesktop && isMobileCompactViewport)`。
