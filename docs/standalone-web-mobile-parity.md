# Standalone Web mobile usability and existing server capabilities

Use the official WebRemoteControlMobileShell Home/Chat navigation. Do not fake a relay switcher, desktop identity or second service owner. Only narrow Web views get compact chat controls; desktop Web keeps its full layout. Preserve task-group ownership fixes, sessions, model settings, Access and Caddy.

Phone acceptance: full-width task home and chat, readable UI (minimum 16px base, respecting larger preferences), 44px main touch targets, dynamic viewport/safe area, visible model label rather than an unexplained cube icon, model/thinking menu within the screen, working back navigation and portrait/landscape recovery. Reuse current model menu and store; no new model state, routing or task framework.

Memory uses the existing connected Host memory service. A false isDesktop flag must not hide a working server memory catalog. Browser settings distinguish Electron-only computer browser import/cache operations from the existing server Chromium MCP. Do not pretend the user's local browser data is accessible remotely.

Validate actual phone interactions at 360/390/412px, settings navigation, memory catalog, model menu, themes and wide Web. No paid Argon/Claude calls. DeepSeek assists only within its explicitly assigned files. Tests/build stay in GitHub Actions; only ZCode is replaced after acceptance, with rollback image and data backup.

Permission UI: show the full requesting subagent type and task description as wrapping text on desktop and phone, not only in a hover title. Reuse the existing bounded scroll layout for subagent/mobile permissions so a long source or expanded command cannot hide the response controls. Preserve command preview expansion, option identities, callbacks, permission scope and decision semantics.

Phone settings rows stack descriptions above controls, removing the desktop 192px reserved column. Constrain controls to the available width; desktop rows retain their existing layout.

Phone settings list spacing: omit the desktop-only 48px window-drag spacer in the mobile single-column list and use 8px top/bottom padding around its back control. Keep at least 44px back-button hit bounds. Preserve desktop/narrow-desktop spacing and all navigation/content behavior. Verify list-top geometry and screenshots at 360/390/412px in both themes, plus unchanged wide Web.

Subagent color selection: center the existing 24px selection indicator vertically within the palette. Mobile radio buttons have 44px minimum touch height, so a fixed top:4px derived from desktop button height is invalid. Preserve the color values, left-position animation, local form state and save behavior. Verify indicator/dot centers for all eight colors on narrow and wide Web in both themes without saving any profile changes.
