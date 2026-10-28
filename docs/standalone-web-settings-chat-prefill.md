# 独立 Web 设置入口的手机草稿导航

新建技能与插件试用均沿现有 Root 新任务路径：prepareSession 成功 → startDraftInWorkspace → 持久化预填草稿并发布 composerTextInsertRequest。普通独立 Web 没有官方 relay 的 openProjectDraft(chat) 回调，手机 Home 不挂载 Composer，预填请求虽已存储却无人消费。

只复用现有 workspace/identity 隔离的 composerTextInsertRequest 作为待消费意图。WorkspaceShellLayout 对当前非 relay、无活动 session 的草稿读取该请求 ID，传给 MobileShell。MobileShell 仍唯一拥有 Home/Chat UI 状态，收到有效请求后进入 Chat，并沿现有 history 写入；Composer 继续唯一消费并清除文本插入请求。不得伪造 popstate、桌面/relay身份或 taskId，不新增业务状态/全局事件/路由框架。

事件顺序：Root 目录准备成功 → 当前 workspace 草稿 + prefill request → MobileShell Chat → Composer 消费一次。准备失败无请求，不导航。普通返回 Home 后无待消费请求，不因旧版本号重新跳入聊天。workspace/identity 变化必须重新按目标读取，不消费旧工作区；真实 relay 路径保持原逻辑，宽屏/桌面不触发手机导航。

回归：从 Home 设置创建技能/插件试用，应进入 Chat，预填文字/mention 保留，不自动发送；重复创建、返回 Home 与切换工作区不重放旧请求；宽屏保留原布局，普通无预填草稿导航保持原入口。
