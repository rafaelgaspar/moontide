# syntax=docker/dockerfile:1
# rafaelgaspar/moontide — Node 26 on Debian forky, built from fork source.
# Generic base image: the MCP server speaks stdio; wrap it (e.g. supergateway)
# for HTTP transports.
FROM debian:forky-slim@sha256:dd5fe0b4f8959afea87fe8d04cd7766aa5905476730607f3d7efacf80552edd3

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_26.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
  && printf '%s\n' \
      'Package: nodejs' \
      'Pin: origin deb.nodesource.com' \
      'Pin-Priority: 1001' \
    > /etc/apt/preferences.d/nodesource \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && node --version \
  && npm --version \
  && groupadd --gid 1000 node \
  && useradd --uid 1000 --gid node --shell /bin/bash --create-home node \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY page ./page
COPY reference ./reference
COPY instruments ./instruments
RUN npm run build && npm prune --omit=dev && npm install -g .

ENTRYPOINT ["moontide-mcp"]
