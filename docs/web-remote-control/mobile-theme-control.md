# 手机远控主题控制

手机远控主题分两段处理：

1. 二维码链接不再追加 `theme` query 参数，避免桌面端主题继续耦合手机端首次进入链路。
2. 手机端 `/remote` 首次打开时，若本机浏览器没有 `localStorage["zcode-theme"]`，会使用默认 `zai-dark` 作为初始主题；后续只使用手机端本地偏好。

这样可以保证之后两端互不影响：手机端切主题只改手机浏览器本地存储，桌面端切主题只改桌面 renderer 的本地存储。

手机端任务首页与桌面共用项目侧栏，主题入口在侧栏底部设置菜单的主题子菜单中；聊天页顶栏右侧渲染 `WebRemoteControlThemeMenu`。两者使用同一组选项：只暴露 `system`、`zai-dark`、`zai-light`，其中 `zai-dark` / `zai-light` 分别显示为 Dark Theme / Light Theme。

## 浏览器表面同步

手机远控运行在普通浏览器页面中，主题切换不能只改变 React 子树。Web 入口必须把同一个 resolved theme 同步到以下浏览器级表面：

- `html`、`body` 和 `#root` 使用当前主题的 `--color-background`，不能继承 Electron vibrancy 所需的透明根背景。
- 文档根的 CSS `color-scheme`（`documentElement.style.colorScheme`）声明当前页面采用的亮暗配色，使原生控件和浏览器默认表面使用一致的配色方案。
- `meta[name="theme-color"]` 使用当前主题的页面背景色，供支持该标准的浏览器着色自身界面。

`<meta name="color-scheme">` 不参与主题同步，始终保持静态 `light dark`，运行时不写入。Firefox Nightly 161+（Mozilla bug 2085572 / 2087391）会用单值 meta 覆写顶层 `prefers-color-scheme`：meta 被写成 `dark` 或 `light` 后，`matchMedia` 不再反映系统主题，系统暗到浅无法恢复，刷新后仍读到旧值。双值 `light dark` 同时允许两种配色，顶层 `prefers-color-scheme` 保持跟随系统，所以 `resolveTheme("system")` 读到的始终是真实系统偏好，手动 light/dark 切回 system 也不需要先解除 meta。实际原生 UI 的单值亮暗仍由上面的 CSS `color-scheme` 控制。

两个浏览器入口都遵守该约束：`packages/web/index.html`（手机远控 Web）和 `packages/web-share/index.html`（会话分享页）的静态 meta 均为 `light dark`。分享页不声明浏览器表面 opt-in，`applyTheme()` 不写根 CSS `color-scheme`，也不新增该能力；它依赖共享 `applyTheme()` 读 `matchMedia` 解析 `system`，因此只需要 meta 保持双值。

该同步是浏览器能力边界，不按 Safari、Chrome、Firefox 或具体系统版本分支。首次加载由 `index.html` 在业务 bundle 执行前根据手机本地偏好完成；运行时切换和 `system` 模式的系统主题变化继续由共享 `applyTheme()` 使用同一 resolved theme 更新。Desktop Electron 不声明浏览器表面 opt-in，继续保留透明根背景和原生窗口 vibrancy。

```text
localStorage / system preference
              |
              v
       resolved light/dark
              |
      +-------+-------------------+
      |                           |
      v                           v
React theme classes       browser theme surface (Web only)
dark / theme-zai-*        root background + CSS color-scheme + theme-color
                          (meta color-scheme stays `light dark`)
```
