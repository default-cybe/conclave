# syntax=docker/dockerfile:1
# Conclave hub image.
#   docker build -t conclave .
#   docker run -d -p 7717:7717 -v conclave-data:/data conclave
# State (config, secrets, SQLite database) lives in /data, and so does the
# conclave user's home (/data/home).

ARG BUN_VERSION=1.4.2

# Workspace manifests only, so dependency layers stay cached until they change.
# Add a line here when a new package with a package.json joins packages/.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/desktop/package.json packages/desktop/
COPY packages/mobile/package.json packages/mobile/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Stage 1: all dependencies, then build the web UI. The output is plain files,
# so this runs natively on the build machine even for multi-arch images.
FROM manifests AS web
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/web packages/web
RUN bun run --filter @conclave/web build

# Production dependencies of the hub only (cli pulls in core and server),
# installed for the target platform.
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY --from=manifests /app ./
RUN bun install --frozen-lockfile --production --filter @conclave/cli

# Final stage: the hub.
# jq is there for hook scripts (every hook recipe and most published hooks read their JSON with it).
# HOOK_PYTHON=1 adds python3 for python hooks such as hookify: docker build --build-arg HOOK_PYTHON=1 .
# HARNESS_NODE=1 (the default) adds Node.js and npm: npx starts the Claude Code and Codex adapters. 0 leaves them out.
# The conclave user's home is /data/home, in the volume, so harness logins
# (~/.claude, ~/.codex), git config and the folder of a session with no folder
# picked survive a new container. /home/conclave links there for older sessions.
# The volume mounts at run time, so conclave-entrypoint makes the folder.
FROM oven/bun:${BUN_VERSION}-slim
ARG HOOK_PYTHON=0
ARG HARNESS_NODE=1
# BROWSER=1 adds the system libraries and fonts Chromium and CloakBrowser need
# (Playwright's list for Debian; Debian 13 names some with t64). The browsers
# themselves install from Settings, Browser into /data/browser.
ARG BROWSER=0
RUN apt-get update \
 && browser_pkgs='' \
 && if [ "$BROWSER" = 1 ]; then \
      . /etc/os-release; t=''; if [ "${VERSION_ID%%.*}" -ge 13 ] 2>/dev/null; then t=t64; fi; \
      browser_pkgs="libasound2$t libatk-bridge2.0-0$t libatk1.0-0$t libatspi2.0-0$t libcairo2 libcups2$t libdbus-1-3 libdrm2 libgbm1 libglib2.0-0$t libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation fonts-noto-color-emoji"; \
    fi \
 && apt-get install -y --no-install-recommends bash ca-certificates git jq ripgrep tini $( [ "$HOOK_PYTHON" = 1 ] && echo python3-minimal ) $( [ "$HARNESS_NODE" = 1 ] && echo nodejs npm ) $browser_pkgs \
 && rm -rf /var/lib/apt/lists/* \
 && printf '#!/bin/sh\nexec bun /app/packages/cli/src/index.ts "$@"\n' > /usr/local/bin/conclave \
 && printf '#!/bin/sh\n# HOME is in the /data volume, which mounts at run time.\nmkdir -p -m 700 "$HOME" || echo "conclave: cannot create $HOME. Logins and files there will not survive a new container." >&2\nexec "$@"\n' > /usr/local/bin/conclave-entrypoint \
 && chmod 755 /usr/local/bin/conclave /usr/local/bin/conclave-entrypoint \
 && groupadd --system conclave \
 && useradd --system --gid conclave --no-create-home --home-dir /data/home --shell /bin/bash conclave \
 && ln -s /data/home /home/conclave \
 && mkdir -p -m 700 /data/home \
 && chown -R conclave:conclave /data

WORKDIR /app
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/cli packages/cli
# ConclaveHelp reads the docs from here when the hub runs from source (core/src/platform/docs.ts)
COPY docs docs
COPY --from=web /app/packages/web/dist packages/web/dist
# The release passes its tag, so the hub says that version (packages/cli/src/version.ts reads this file).
ARG CONCLAVE_VERSION=
RUN if [ -n "$CONCLAVE_VERSION" ]; then \
      bun -e 'const f = "packages/cli/package.json"; const p = await Bun.file(f).json(); p.version = process.env.CONCLAVE_VERSION.replace(/^v/, ""); await Bun.write(f, JSON.stringify(p, null, 2) + "\n");'; \
    fi

# CONCLAVE_INSTALL: the hub shows the pull command instead of updating itself (docs/INSTALL.md, Updates)
ENV CONCLAVE_HOME=/data \
    HOME=/data/home \
    NODE_ENV=production \
    CONCLAVE_INSTALL=docker
USER conclave
VOLUME /data
EXPOSE 7717

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.CONCLAVE_PORT || 7717) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# tini reaps the shells and tools the agent starts.
ENTRYPOINT ["tini", "--", "conclave-entrypoint"]
CMD ["bun", "packages/cli/src/index.ts", "serve", "--host", "0.0.0.0"]
