# 独立 Web 实施基线

- 记录日期：2026-11-12
- 仓库：`uselessbug/ZCode`
- 分支：`main`
- 修改前远端 main：`364e6c55`
- 完整 SHA：`364e6c551a0ec0680488e558bf01459da555e1e1`
- 原提交：`feat(web): enable server personalization settings`

该提交是本轮改动前的源码回退基线。需要回退时从此提交构建镜像（或使用对应提交的 `sha-<8位>` 镜像标签），不要只依赖可能已更新的 `latest` 标签。源码与镜像回退不应覆盖部署后新增的会话、记忆或配置数据。

本轮直接在本地 `main` 修改，代码与本地自动化校验已通过；完整打包与镜像产物统一由 GitHub Actions 在目标提交上构建产出，不要求扩容本地构建内存。CI 完成后由用户拉取对应提交镜像执行实机部署与验证。

## 关联文档

- [独立 Web 与移动端适配问题清单](./issues.md)
- [独立 Web 部署与实机验证清单](./standalone-web-deployment-checklist.md)
- [多 root 项目与任务移动](../standalone-web-multi-root-projects.md)
- [设置页服务边界与手机布局](../standalone-web-settings.md)
- [Node 统一发行包规格](../../specs/zcode-unified-distribution.md)
