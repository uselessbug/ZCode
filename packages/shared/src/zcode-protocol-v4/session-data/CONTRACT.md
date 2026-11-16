# protocol-session-data

`v4/storage/sessionData/measure` 与 `v4/storage/sessionData/purge` 的载荷 schema：Host 为「设置 → 项目」的彻底删除数据向 CLI 测量、删除会话与目录记忆。规格见 `docs/superpowers/specs/2026-10-24-project-management.md`「彻底删除数据」。

不变量：

- CLI 不感知项目：载荷只有会话根 ID 与目录（`workspacePath` + 可选 `workspaceIdentity`）。后代会话由 CLI 按 `parent_id` 的自有类型与 `session_task_link` 查找，fork 不算后代。
- 大小只统计从磁盘真实删除的文件；数据库行删除不计入（库文件不收缩）。
- purge 幂等：已不存在的会话按 0 字节删除成功。`deleted` 每项除根 `sessionId` 与 `bytes` 外，可选携带 `sessionIds`（该根及其实际一并清除的自有后代会话 ID 全集，供 Host 回收子会话级派生资源如独立浏览器上下文）。运行中的会话整棵保留并以 `kept`（`reason: "running"`）返回；附件仍被本次不删除的会话引用的会话整棵保留（`reason: "referenced"`）；文件删不掉的会话保留行，以 `failed` 返回错误码，供重试。
- 方法名在 `transport.ts` 的 `V4_METHODS` 冻结；旧 CLI 返回 method-not-found，Host 据此隐藏选项。
