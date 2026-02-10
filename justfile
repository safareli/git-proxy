# Show available commands
help:
    @just --list

# Run dev server (foreground)
dev:
    bun run --env-file=.config --watch src/index.ts

# Start dev server in background with tmux and tail logs
dev-up:
    tmux kill-session -t git-proxy 2>/dev/null || true
    : > /tmp/git-proxy.log
    tmux new -d -s git-proxy 'bun run --env-file=.config --watch src/index.ts 2>&1 | tee /tmp/git-proxy.log'
    tmux set -t git-proxy status-right 'detach: C-b d | help: C-b ?'
    @echo 'Started. Attach: just dev-attach | Logs: just dev-logs'

# Stop background dev server
dev-down:
    tmux kill-session -t git-proxy 2>/dev/null || true

# Attach to background dev server (detach: Ctrl+B d)
dev-attach:
    tmux attach -t git-proxy

# Tail dev server logs
dev-logs:
    tail -f /tmp/git-proxy.log

# Build binary
build:
    bun build --compile --outfile git-proxy ./src/index.ts

# Docker compose up
docker-up:
    docker compose down && docker compose up

# Docker compose up detached
docker-upd:
    docker compose down && docker compose up --detach

# Docker compose up fresh (rebuild, remove volumes)
docker-upf:
    docker compose down -v && docker compose up --build

# Run typecheck
typecheck:
    tsgo

# Run tests
test:
    bun test
