# Build stage
FROM oven/bun:1-alpine AS builder

WORKDIR /build

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/

# Build single binary
RUN bun run build

# Runtime stage
FROM alpine:latest

RUN apk add --no-cache git git-daemon openssh-client libstdc++ libgcc

# Create non-root user
RUN adduser -D -h /var/lib/git-proxy git-proxy

# Copy binary from builder
COPY --from=builder /build/git-proxy /usr/local/bin/git-proxy

# Create directories
RUN mkdir -p /etc/git-proxy /var/lib/git-proxy/repos && \
    chown -R git-proxy:git-proxy /var/lib/git-proxy

USER git-proxy

WORKDIR /var/lib/git-proxy

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/git-proxy"]
