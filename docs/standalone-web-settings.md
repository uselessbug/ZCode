> 本规格描述已直接集成到当前源码的独立 Web 行为。下文的基础版本和补丁顺序仅是历史背景；构建使用本仓库当前源码，不再应用外部覆盖补丁。

# 独立 Web / 手机远控 设置页：服务能力边界与手机布局

固定上游 3c5b227649371507ddc4eb46ac5133afe6db1cab（3.16.2）基础上，本 spec 覆盖设置页两件事：**服务能力边界**（记忆浏览不再按桌面平台假门禁）与**手机单栏布局**。连接生命周期另见 [连接恢复](standalone-web-recovery.md)，任务/项目兼容见 [任务和项目](standalone-web-task-and-project-compat.md)。

不引入能力注册框架，也不新增第二份能力配置。

## 状态所有者与接口

| 事实                                         | 唯一所有者                                                                         | 读取接口                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| 项目记忆 catalog（按 workspace 的 Markdown） | 所属 Host 数据根 `<dataRoot>/cli/memories/projects` 的 `IMemoryService`            | `SettingsPage` 的 `localHostServices.memoryService` |
| `localHostServices` 的归属                   | 各入口注入的 base Host（桌面本机 Host / 云端 server Host / 手机远控被控桌面 Host） | `useBaseWorkspaceServices()`                        |
| 记忆开关与存储格式                           | 各 base Host 的 `settingService`（`memoryEnabled`）                                | `useSettings({ services: localHostServices })`      |
| 设置页手机导航态                             | `SettingsPage` 局部状态（一个布尔）                                                | `mobileSettingsDetailOpen`                          |

### 记忆浏览：按服务边界判定，不按平台

```mermaid
sequenceDiagram
    participant UI as SettingsPage / MemorySettingsSection
    participant Host as base Host IMemoryService
    UI->>Host: listProjectMemories()
    alt 桌面 / 云端 Web / 手机远控（已连桥）
        Host-->>UI: 该 Host 的项目记忆（服务端记忆，不读手机本机文件）
    else 手机远控 home-only（未连桥）
        Host-->>UI: []（空兜底）
    end
```

- `MemorySettingsSection` 的 `projectMemoryViewerAvailable` 不再由 `Boolean(isDesktop)` 决定。base Host 始终提供 `IMemoryService` 契约，桌面、云端 Web、手机远控都通过同一 `localHostServices` 代理读取所属 Host 的项目记忆；旧的 `isDesktop` 门禁把已有服务在 Web 上误判为不可用。
- 不伪造桌面平台，不改 `memoryEnabled` 开关与存储格式，不读手机本机文件；服务读取、禁用开关、错误显示沿用 `MemorySettingsSection` 既有实现。
- 已知边角：手机远控 home-only 未连桥时 catalog 返回空，展示“空”而非“仅本地”。

### 个性化指令：复用官方编辑器

- 独立 Web（电脑与手机）通过 base Host 的 `settingService` 读写服务器 `~/.zcode/AGENTS.md`，复用官方保存/取消、草稿恢复及 100KB 限制；界面说明明确指向当前服务器 Agent。
- 桌面端仍编辑本机用户指令；官方 relay 手机远控仍保留仅桌面端提示。入口边界及验收场景见 [个性化规格](ui/settings-personalization.md)。
- 不新增 API、配置文件或持久化目录，已有用户指令不作迁移或初始化覆盖。

### 浏览器数据：区分三类浏览器

| 概念                | 运行位置                                             | 设置页行为                                   |
| ------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Electron 内置浏览器 | 桌面主进程 `<webview>` guest，`browser-use` 插件驱动 | Chrome 数据导入/清理、忽略证书校验仅桌面可用 |
| Chromium MCP        | 服务端/Agent 运行所在 Host 的无头 Chromium（MCP）    | 不受内置浏览器数据设置限制，Web 上仍可用     |
| Web 页面自身浏览器  | 渲染 Web UI 的手机/电脑浏览器                        | 无控制桥；`openExternal` 仅 `window.open`    |

- `BrowserSettingsSection` 在 `!nativeActionsAvailable` 时按平台区分提示：桌面缺方法用 `settings.browser.desktopOnly`；Web/手机用 `settings.browser.webUnsupported`，明确当前网页无法导入用户电脑 Chrome 数据/清理 Electron 内置浏览器数据，且服务端 Agent 的 Chromium MCP 不受此限制。
- 保留已有 `browser-use` 插件开关与安全区（`isDesktop` 门禁），不新增远程浏览器界面或导入协议。

## 记忆正文：页内查看与最小编辑

历史症状（见[问题清单](maintenance/issues.md)）：设置页“记忆”分区已能列出服务端项目记忆文件，但点击文件仍调用本机外部编辑器，独立 Web 下没有可达入口。修复原则是**页内查看 + 最小编辑**，不引入完整 IDE。

### 状态所有者与接口

| 事实                                  | 唯一所有者                                                              | 读取/写入接口                                          |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| 项目记忆 Markdown 正文                | 所属 Host 数据根 `<dataRoot>/cli/memories/projects` 的 `IMemoryService` | `readProjectMemoryFile` / `saveProjectMemoryFile`      |
| 记忆文件内容版本（mtime + 内容 hash） | `IMemoryService` 稳定读取结果                                           | `readProjectMemoryFile` 返回 `updatedAt`/`contentHash` |
| 编辑草稿、冲突提示、保存中态          | `MemorySettingsViewer` 局部状态                                         | 不写入 store，不持久化                                 |

### 契约

- **复用官方只读路径**：正文查看走既有 `readProjectMemoryFile`，继续复用 `projectMemoryStableRead` 的稳定句柄、5 MiB 上限、大小写精确匹配与 `path` 越界校验；不新增第二套读取。
- **新增最小写入** `saveProjectMemoryFile(params)`，`params = { workspaceId, fileName, content, expectedUpdatedAt, expectedContentHash }`：
  - 只允许写已存在的项目记忆 Markdown（`requireExactProjectMemoryFile`），**不新建文件、不接受任意路径**，因此不构成通用任意文件写 API。
  - 写入前用稳定读取重新取当前 `updatedAt` + `contentHash`，与期望值不一致（文件被改动、删除或替换）时抛 `PROJECT_MEMORY_FILE_CHANGED`，**不覆盖**，UI 保留草稿并提示。
  - 写入采用同目录临时文件 + `rename` 的原子替换，正文超限按 `PROJECT_MEMORY_FILE_CHANGED` 同级的写上限错误拒绝。
  - **诚实边界**：检查与 `rename` 之间存在窗口，外部写手仍可能在该窗口替换文件；本实现只保证“读取时刻已变化则拒绝覆盖”，不以锁或超时掩盖这一竞态。
- **不把旧 `saveMemory`（`~/.claude/memory/MEMORY.md` 用户级路径）用于项目记忆**：`saveMemory` 的所有者与路径不同，保持原样。
- **预览/编辑复用既有组件**：正文预览复用 PreviewPane 的 Markdown 渲染（`MarkdownPreviewContent`），编辑使用既有文本框与按钮，不新增富文本或 IDE 依赖；复制路径复用 `useFileContextActions.copyPath`。
- 桌面端不再因 `isDesktop` 差异隐藏页内入口，行为对齐；外部编辑器入口（`WorkspaceEditorButtonGroup`）在 Web 仍不可用，由页内入口取代。

### 验收场景

1. 云端 Web / 桌面：记忆分区点击某文件进入页内查看，渲染 Markdown 正文；顶部提供复制路径、编辑、关闭。
2. 进入编辑修改正文并保存：服务器文件内容更新，列表更新时间刷新；重新打开可见新内容。
3. 读取后文件被外部改写/删除，再保存：提示冲突（`PROJECT_MEMORY_FILE_CHANGED`），**不写入**，编辑框保留草稿；可刷新后重新编辑。
4. 桌面端行为不变，外部编辑器按钮组在该分区不再出现。

## 技能“打开路径”：服务端目录浏览

历史症状：技能详情“打开路径”在独立 Web 下调用桌面文件管理器接口，没有可达行为。

- 桌面端保持既有 `platform.openInFileManager`（本机文件管理器，远端非 WSL 目录不交给本机）。
- 独立 Web / 手机远控：有活动工作区时走页内服务端目录浏览，复用 `openFileManagerSidePane`（通过 window 级 `requestFileManager` 提交目标，由 workspace shell 消费并打开右侧文件管理面板）；无活动工作区时改用页内 `DirectoryBrowser` 弹窗浏览，避免把技能目录当成持久工作区新建标签。
- 入口判定复用既有 `useFileContextActions.canRevealInFileManager`：只有“可打开本机文件管理器”的宿主才走系统接口，其余走页内面板或目录浏览弹窗。**不把浏览器所在电脑路径当服务端路径**，目录选择与浏览一律使用服务端 Host 的能力。

### 验收场景

1. 独立 Web：技能详情点击“打开路径”，有活动工作区时右侧打开文件管理面板定位到该目录，无活动工作区时打开页内目录浏览弹窗且不残留持久工作区标签。
2. 桌面端：点击“打开路径”仍调用本机文件管理器，行为不变。

## 插件来源：服务端目录选择

历史症状：`AddMarketplaceSourceDialog` 在独立 Web 隐藏“选择目录”，无法添加服务端本地目录来源。

- 桌面端保持原生 `platform.selectDirectory` 与拖放（拖放解析的是受控端本机路径）。
- 独立 Web：复用既有 `DirectoryBrowser`（服务端 `fileService.readdir` 浏览），在对话框内嵌选择服务端目录，选中的服务端绝对路径写回来源输入框。**浏览器所在电脑路径不作为 server 路径**。
- 不新增后端接口；`DirectoryBrowser` 优先使用 `PluginStorePage` 传入的与 `addMarketplace` 同源的 `services`（缺省回退 `localHostServices`）。

### 验收场景

1. 独立 Web：点击“选择目录”在对话框内浏览服务端目录，确认后来源输入框填充服务端路径，可继续添加。
2. 桌面端：“选择目录”仍打开系统目录选择框。

## 设置页 Scope 文案：当前服务器 / 当前项目

- 独立 Web（含手机远控）下当前服务器承载的 `local` 设备 `user` 作用域指向**当前服务器 Host**：文案统一为“当前服务器”，不写死服务器地址或凭据，不使用浏览器本机语义；远端（`remote`）设备分组仍显示其设备名与“用户”标签。
- project 作用域仍指**当前项目**，判定与数据不改。
- 四类资源（技能 / 子代理 / MCP / 指令）的 scope 归属保持一致：user/local → 当前服务器，project → 当前项目；不伪造平台、不改 scope 数据。

### 验收场景

1. 独立 Web：设置页技能、子代理、MCP 的 user/local 选项文案显示“当前服务器”，project 显示“当前项目”。
2. 桌面端：文案与作用域行为不变。

## 手机设置页单栏布局

- 生效条件：`!isDesktop && useIsMobileCompactViewport()`（`max-width: 767px`）。宽屏桌面与窄窗口桌面保持原双栏。
- 根容器标记 `data-mobile-settings`；单栏下列表与详情互斥显示，不再保留桌面 68px 图标栏。
- 列表态：复用现有导航按钮，列表项显示图标 + 完整文字（不折叠成图标栏），触控高度 ≥44px；保留返回工作区入口。
- 详情态：保留设置标题与可触控返回按钮（回到列表）；其余设置内容与桌面一致。
- 不复制设置业务状态，仅新增一个导航布尔；使用现有 `useIsMobileCompactViewport` 与设计 token，不修改 html 字体缩放。

## 验收场景

1. 桌面端：设置页仍为左侧导航 + 内容双栏，导航项在窄窗口保持图标栏；记忆浏览与浏览器数据行为不变。
2. 云端 Web / 手机远控（已连桥）：记忆设置可浏览**服务端/被控端**项目记忆，不读手机本机文件；`memoryEnabled` 开关与存储格式不变。
3. 手机（≤767px，非桌面）：设置页进入列表页（图标 + 完整文字，触控 ≥44px）；点击某分区进入单栏详情；详情返回按钮回到列表。
4. Web 设置页“浏览器数据”提示为 `settings.browser.webUnsupported`，说明 Chromium MCP 不受限；桌面端提示不变，Chrome 数据导入/清理按钮在 Web 仍禁用。
