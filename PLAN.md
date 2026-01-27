# Git Proxy - Design & Implementation Plan

A secure git proxy that accepts pushes from untrusted environments, validates them, and forwards to GitHub.

## Problem Statement

Allow an untrusted agent (e.g., AI running with dangerous permissions) to push code to GitHub, but:
- Only to specific branches (e.g., `agent/*`)
- Never modifying sensitive files (e.g., `.github/workflows/`)
- With strong consistency guarantees (if push succeeds, it's on GitHub)

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────────────────────────────────────┐
│ Untrusted Agent │  HTTP   │  Proxy (Container/VM)                                │
│                 │────────▶│                                                      │
│                 │         │  ┌────────────────────────────────────────────────┐  │
│                 │         │  │ HTTP Wrapper Server                            │  │
│                 │         │  │                                                │  │
│                 │         │  │  1. Parse request → identify repo              │  │
│                 │         │  │  2. Acquire per-repo lock                      │  │
│                 │         │  │  3. git fetch origin (ensure fresh)       ─────────▶ GitHub
│                 │         │  │  4. Proxy to git-http-backend ──┐              │  │
│                 │         │  │                                 │              │  │
│                 │         │  └─────────────────────────────────│──────────────┘  │
│                 │         │                                    ▼                 │
│                 │         │  ┌─────────────────────────────────────────────────┐ │
│                 │         │  │ git-http-backend                                │ │
│                 │         │  │   │                                             │ │
│                 │         │  │   └─▶ pre-receive hook                          │ │
│                 │         │  │         - validate branch                       │ │
│                 │         │  │         - validate paths                        │ │
│                 │         │  │         - git push origin (SYNC!) ──────────────────▶ GitHub
│                 │         │  │         - reject if upstream fails              │ │
│                 │         │  │                                                 │ │
│                 │◀────────│  └─────────────────────────────────────────────────┘ │
│ (success/error) │         │                                                      │
└─────────────────┘         └──────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Synchronous Fetch Before All Operations
- Every clone/fetch from proxy first fetches from GitHub
- Ensures agent always sees up-to-date state
- Per-repo locking prevents races

### 2. Synchronous Push to GitHub
- `pre-receive` hook validates AND pushes to GitHub
- If GitHub push fails, local push is also rejected
- Agent sees error immediately
- Guarantees: if agent sees "success", it's on GitHub

### 3. Validation in pre-receive Hook
- Branch name validation (allowed/blocked patterns)
- Protected path validation (diff against origin/main)
- Force push detection and policy enforcement
- Upstream divergence detection

### 4. HTTP (not SSH)
- No shell access, smaller attack surface
- Easier to sandbox
- Private network, no TLS needed

---

## Configuration

```json
{
  // SSH key for GitHub access (or set GIT_SSH_KEY env var)
  // "ssh_key_path": "/run/secrets/git-ssh-key",

  "repos": {
    "myproject": {
      "upstream": "git@github.com:user/myproject.git",

      // Glob patterns for files that cannot be modified
      "protected_paths": [
        ".github/**",
        "*.nix",
        "nix/",
        "Makefile"
      ],

      // Branch restrictions (use ONE of these, not both)
      // Option A: Only these branches allowed
      "allowed_branches": [
        "agent/*",
        "ai/*",
        "feature/*"
      ],

      // Option B: These branches blocked, rest allowed
      // "blocked_branches": [
      //   "main",
      //   "master",
      //   "release/*"
      // ],

      // Force push policy: "deny" (default) | "allow"
      "force_push": "deny",

      // Branch to diff against for protected path checks
      "base_branch": "main"
    },

    "another-repo": {
      "upstream": "git@github.com:user/another.git",
      "protected_paths": [
        ".github/workflows/**"
      ],
      "blocked_branches": [
        "main",
        "master"
      ],
      "force_push": "allow"
    }
  }
}
```

Note: JSON doesn't support comments, but they're shown above for documentation. Use JSONC (JSON with Comments) if your editor supports it, or keep a separate documentation file.

---

## Directory Structure

```
/home/safareli/dev/git-proxy/
├── PLAN.md                 # This file
├── README.md               # User documentation
├── config.example.json     # Example configuration
├── package.json            # Bun project config
├── tsconfig.json           # TypeScript config
│
├── src/
│   ├── index.ts            # Entry point
│   ├── server.ts           # HTTP wrapper server
│   ├── git-backend.ts      # git-http-backend proxy logic
│   ├── config.ts           # Config parsing & validation (JSON)
│   ├── hooks.ts            # Pre-receive hook logic (runs in same process)
│   └── utils.ts            # Helpers (locking, git commands, glob matching)
│
├── Dockerfile              # Container build (minimal: just git + binary)
├── docker-compose.yaml     # Example deployment
│
└── tests/
    └── *.test.ts           # Bun test files
```

---

## Components

### 1. HTTP Server (`src/server.ts`)

**Responsibilities:**
- Listen on HTTP port (default 8080) using `Bun.serve()`
- Route requests to appropriate repo
- Acquire per-repo lock before any operation
- Fetch from origin before proxying
- Proxy to git-http-backend

### 2. Git Backend Proxy (`src/git-backend.ts`)

**Responsibilities:**
- Set up CGI environment for git-http-backend
- Execute `git http-backend` as subprocess via `Bun.spawn()`
- Parse CGI response into HTTP Response

**Approach:** Buffered CGI (simple version)
- Read entire request/response into memory
- 100MB max body size (configurable)
- Upgrade to streaming in final phase if needed

### 3. Hook Logic (`src/hooks.ts`)

**Responsibilities:**
- Called by git-http-backend via pre-receive hook
- The actual hook script is minimal - just calls back to our server or binary
- Validation logic:
  1. Validate branch name against allowed/blocked patterns
  2. Detect force push, check policy
  3. Check if upstream diverged
  4. Diff against origin/main, check protected paths
  5. If all OK: push to GitHub synchronously
  6. If GitHub push fails: return error
- Returns success/failure + messages to send to agent

**Hook approach options:**
- Option A: Hook script calls `git-proxy validate` subcommand
- Option B: Hook script makes HTTP request to proxy server
- Option C: Hook is a shell script that does validation directly

### 4. Config Module (`src/config.ts`)

**Responsibilities:**
- Load and validate config.json
- TypeScript types for config
- Validation with helpful error messages

### 5. Initialization (`src/index.ts`)

**Responsibilities:**
- Parse CLI args and env vars
- Load config
- For each repo:
  - Create bare repo if not exists
  - Set up origin remote
  - Install pre-receive hook
  - Initial fetch from upstream
- Start HTTP server

---

## Request Flow

### Clone/Fetch Flow

```
1. Agent: git clone http://proxy:8080/myproject.git
2. Server: Parse request → repo = "myproject"
3. Server: Acquire lock for "myproject"
4. Server: git fetch origin (in bare repo)
5. Server: Proxy to git-http-backend
6. git-http-backend: Serve refs and pack
7. Agent: Receives up-to-date content
8. Server: Release lock
```

### Push Flow

```
1. Agent: git push proxy agent/feature
2. Server: Parse request → repo = "myproject"
3. Server: Acquire lock for "myproject"
4. Server: git fetch origin (ensure fresh main)
5. Server: Proxy to git-http-backend

6. git-http-backend: Receive pack, call pre-receive hook
7. pre-receive:
   a. Read: "oldsha newsha refs/heads/agent/feature"
   b. Check branch name → OK
   c. Check force push → OK (not force push)
   d. Check upstream divergence → OK
   e. Diff origin/main..newsha → get changed files
   f. Check protected paths → OK (no violations)
   g. git push origin newsha:refs/heads/agent/feature → OK
   h. Exit 0 (accept)

8. git-http-backend: Update local refs
9. Agent: Sees "success" message
10. Server: Release lock
```

### Push Rejection Flow

```
1-6. Same as above...
7. pre-receive:
   a. Read: "oldsha newsha refs/heads/agent/feature"
   b. Diff origin/main..newsha → [".github/workflows/ci.yml", "src/main.py"]
   c. Check protected paths → VIOLATION: .github/workflows/ci.yml
   d. Print error to stderr
   e. Exit 1 (reject)

8. git-http-backend: Reject push, send error to client
9. Agent: Sees rejection message with details
10. Server: Release lock
```

---

## Security Considerations

### Attack Surface
- HTTP server (Bun) - parses HTTP requests
- git-http-backend - parses git protocol
- Git itself - processes pack files

### Mitigations
1. **No shell access** - Only HTTP, no SSH
2. **Hooks are read-only** - Agent cannot modify hooks via push
3. **Validation before accept** - Bad pushes never stored locally
4. **Per-repo locking** - No race conditions
5. **Container isolation** - Run in minimal container
6. **Credentials isolation** - GitHub SSH key only accessible to hook process

### What Agent Cannot Do
- Push to protected branches (main, etc.)
- Modify protected files (.github/workflows/, etc.)
- Access GitHub credentials
- Modify proxy configuration or hooks
- See other repos' data (only configured repos exposed)

---

## Build & Runtime

### Build
```bash
bun build --compile --outfile git-proxy ./src/index.ts
```

Produces a single `git-proxy` binary (~50-100MB) with Bun runtime embedded.

### Runtime Dependencies
- `git` (includes `git http-backend`) - **only runtime dependency**

### Minimal Container
```dockerfile
FROM alpine:latest
RUN apk add --no-cache git openssh-client
COPY git-proxy /usr/local/bin/
ENTRYPOINT ["git-proxy"]
```

---

## Deployment

### Environment Variables
```bash
GIT_SSH_KEY         # Private key content for GitHub access
GIT_PROXY_CONFIG    # Path to config (default: /etc/git-proxy/config.json)
HTTP_PORT           # Port to listen on (default: 8080)
REPOS_DIR           # Bare repos location (default: /var/lib/git-proxy/repos)
LOG_LEVEL           # debug/info/warn/error (default: info)
```

### Docker
```bash
docker run -d \
  --name git-proxy \
  -e GIT_SSH_KEY="$(cat ~/.ssh/github_deploy_key)" \
  -v ./config.json:/etc/git-proxy/config.json:ro \
  -v git-proxy-repos:/var/lib/git-proxy/repos \
  -p 8080:8080 \
  git-proxy:latest
```

### Docker Compose
```yaml
version: '3.8'
services:
  git-proxy:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./config.json:/etc/git-proxy/config.json:ro
      - repos:/var/lib/git-proxy/repos
    environment:
      - GIT_SSH_KEY_FILE=/run/secrets/ssh_key
    secrets:
      - ssh_key

volumes:
  repos:

secrets:
  ssh_key:
    file: ./github_deploy_key
```

---

## Implementation Phases

### Phase 1: Core Functionality
- [x] Project setup (package.json, tsconfig.json)
- [x] Config parsing - JSON (`src/config.ts`)
- [x] HTTP server with git-http-backend proxy (`src/server.ts`, `src/git-backend.ts`)
- [x] Basic pre-receive hook (branch validation only)
- [x] Repo initialization on startup
- [x] Manual testing

### Phase 2: Full Validation
- [x] Protected path validation in pre-receive
- [x] Force push detection
- [x] Upstream divergence check
- [x] Synchronous push to GitHub
- [x] Error messages to agent

### Phase 3: Packaging
- [ ] Build script (`bun build --compile`)
- [ ] Dockerfile (minimal: alpine + git + binary)
- [ ] docker-compose.yaml
- [ ] README with usage instructions
- [ ] Example config

### Phase 4: Hardening & Testing
- [ ] Bun tests
- [ ] Integration tests
- [ ] Timeout handling
- [ ] Graceful shutdown
- [ ] Logging
- [ ] Health check endpoint

### Phase 5: Streaming & Performance
- [ ] Upgrade git-backend.ts to streaming CGI
  - Stream request body to git http-backend stdin
  - Stream response body from stdout
  - Removes 100MB body size limit
  - Better memory usage for large pushes

### Phase 6: Optional Enhancements
- [ ] NixOS module
- [ ] Multiple GitHub credentials (per-repo)
- [ ] Webhook notifications on push
- [ ] Web UI for status/logs
- [ ] Rate limiting

---

## Open Questions

1. **Read/write locking**: Should we allow concurrent reads (fetch/clone) but exclusive writes (push)? Current plan is exclusive lock for simplicity.

2. **Fetch timeout**: What timeout for GitHub fetch? (Suggest: 60s)

3. **Push timeout**: What timeout for GitHub push? (Suggest: 120s)

4. **Large pushes**: Any size limits? Git has `http.postBuffer`, might need tuning.

5. **Audit logging**: Should we log all push attempts (success/failure) with details?

---

## Agent Usage

```bash
# From the untrusted agent environment:

# Clone a repo
git clone http://git-proxy:8080/myproject.git
cd myproject

# Work on allowed branch
git checkout -b agent/my-feature
# ... make changes (not to protected files!) ...
git commit -m "Add feature"

# Push - will be validated and forwarded to GitHub
git push origin agent/my-feature

# If rejected, agent sees clear error message:
# remote: ========================================
# remote: PUSH REJECTED  
# remote: ========================================
# remote: Changes to protected paths detected:
# remote:   - .github/workflows/ci.yml
# remote: ========================================
```
