FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build-base
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /src
COPY . .
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_OPTIONS=--max-old-space-size=8192
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck && pnpm lint
# 依赖就绪即可运行、不需要构建产物的门禁：发行包收集器契约与四个独立 Web/server 验收脚本。
RUN node --test scripts/zcode-distribution.test.mjs
RUN pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-memory-files.mjs \
    && pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-multi-root-projects.mjs \
    && node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-mcp-routing.mjs \
    && pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-archived-deletion-carrier.mjs

# ci-deps 是给 CI 复用的依赖层边界：workflow 以 --target ci-deps 构建到这里，
# 在运行期只读挂载 .git（.dockerignore 排除了它）跑 architecture:check --changed，
# 复用同一份已安装依赖，避免在 runner 上再做一次全量 pnpm install。
FROM build-base AS ci-deps

# ci-browser 只服务于定向浏览器回归：在 ci-deps 之上补系统 Chromium 与中文字库。
# 刻意做成 ci-deps 的同级 stage（而非 build 的中间层），正式 build 仍从 ci-deps 出发，
# 不把浏览器依赖带进 build 与最终 runtime 镜像。
FROM ci-deps AS ci-browser
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
# 定向 Provider 详情反馈竞态回归（src 修复随源码进入本 stage）。
# 测试自身用 chromium.launch() 且未开 chromiumSandbox，Playwright 默认即 --no-sandbox，容器 root 可直接跑。
RUN node --test packages/ui/test/browser/manual-review/pending/provider-feedback-race.test.mjs

FROM ci-deps AS build
RUN pnpm --filter @zcode/server... build
# shared is source-exported and has no build script; the distribution collector
# nevertheless requires its emitted files. Match the other runtime transpilation.
RUN pnpm exec tsc -p packages/shared/tsconfig.json --noCheck \
    && test -f packages/shared/dist/index.js
# Stage the official distribution layout for the runtime image.
RUN pnpm build:zcode --base-url https://github.com/uselessbug/ZCode/releases/download \
    && mkdir /runtime \
    && tar -xzf dist/zcode/releases/*/zcode-*.tar.gz -C /runtime
# 发行包端到端验收：直接用刚生成的 tar 跑一次 TUI/native/web 与内置资产检查（不调用模型）。
# 容器构建阶段无系统 Secret Service，仅为此一次性验收命令传入合成密钥，不写入镜像 ENV。
RUN ZCODE_CREDENTIAL_SECRET=ci-distribution-smoke-synthetic-secret-not-for-prod \
    node scripts/zcode-distribution-smoke.mjs "$(ls dist/zcode/releases/*/zcode-*.tar.gz)"

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/uselessbug/ZCode" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client bash python3 python3-venv ca-certificates curl ripgrep \
    chromium fonts-noto-cjk unzip zip \
    && rm -rf /var/lib/apt/lists/*
# Install the official latest stable GH CLI whenever release metadata changes.
# Remote ADD checks release metadata so this layer can refresh across builds.
ADD https://api.github.com/repos/cli/cli/releases/latest /tmp/gh-cli-release.json
RUN set -eu \
    && test "$(dpkg --print-architecture)" = arm64 \
    && GH_CLI_VERSION="$(python3 -c 'import json; print(json.load(open("/tmp/gh-cli-release.json"))["tag_name"].removeprefix("v"))')" \
    && curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 --proto '=https' --tlsv1.2 \
        "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_arm64.tar.gz" \
        --output "/tmp/gh_${GH_CLI_VERSION}_linux_arm64.tar.gz" \
    && curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 --proto '=https' --tlsv1.2 \
        "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_checksums.txt" \
        --output /tmp/gh-cli-checksums.txt \
    && (cd /tmp && sha256sum --check --strict --ignore-missing gh-cli-checksums.txt) \
    && tar --extract --gzip --file "/tmp/gh_${GH_CLI_VERSION}_linux_arm64.tar.gz" --directory /usr/local/bin \
        --strip-components=2 --no-same-owner "gh_${GH_CLI_VERSION}_linux_arm64/bin/gh" \
    && chmod 0755 /usr/local/bin/gh \
    && rm "/tmp/gh_${GH_CLI_VERSION}_linux_arm64.tar.gz" /tmp/gh-cli-checksums.txt /tmp/gh-cli-release.json \
    && gh --version
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --prefix /opt/browser-mcp --omit=dev --save-exact @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}
RUN groupadd --gid 1001 agent && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash agent
COPY --from=build /runtime/zcode /app/zcode
RUN mkdir /workspace /artifacts && chown agent:agent /workspace /artifacts
USER 1001:1001
ENV HOME=/home/agent \
    ZCODE_SERVER_HOST=0.0.0.0 \
    ZCODE_SERVER_WORKSPACE=/workspace \
    ZCODE_WEB_STATIC_ROOT=/app/zcode/web \
    ZCODE_AGENT_SERVER_COMMAND=/usr/local/bin/node \
    ZCODE_AGENT_SERVER_ARGS_JSON='["/app/zcode/agent/zcode.cjs","app-server","--stdio"]' \
    PORT=3030
WORKDIR /workspace
EXPOSE 3030
ENTRYPOINT ["node", "/app/zcode/server/entry-http.js"]
