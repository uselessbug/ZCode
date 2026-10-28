FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /src
COPY . .
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_OPTIONS=--max-old-space-size=8192
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck && pnpm lint
RUN pnpm --filter @zcode/server... build
# shared is source-exported and has no build script; the distribution collector
# nevertheless requires its emitted files. Match the other runtime transpilation.
RUN pnpm exec tsc -p packages/shared/tsconfig.json --noCheck \
    && test -f packages/shared/dist/index.js
# Stage the official distribution layout for the runtime image.
RUN pnpm build:zcode --base-url https://github.com/uselessbug/ZCode/releases/download \
    && mkdir /runtime \
    && tar -xzf dist/zcode/releases/*/zcode-*.tar.gz -C /runtime

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
COPY docker/entrypoint.mjs /app/entrypoint.mjs
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
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
