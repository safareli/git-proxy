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

```yaml
# config.yaml

# SSH key for GitHub access (or set GIT_SSH_KEY env var)
# ssh_key_path: /run/secrets/git-ssh-key

repos:
  myproject:
    upstream: git@github.com:user/myproject.git
    
    # Glob patterns for files that cannot be modified
    protected_paths:
      - ".github/**"
      - "*.nix"
      - "nix/"
      - "Makefile"
    
    # Branch restrictions (use ONE of these, not both)
    # Option A: Only these branches allowed
    allowed_branches:
      - "agent/*"
      - "ai/*"
      - "feature/*"
    
    # Option B: These branches blocked, rest allowed
    # blocked_branches:
    #   - main
    #   - master
    #   - "release/*"
    
    # Force push policy: "deny" (default) | "allow"
    force_push: "deny"
    
    # Branch to diff against for protected path checks
    base_branch: "main"

  another-repo:
    upstream: git@github.com:user/another.git
    protected_paths:
      - ".github/workflows/**"
    blocked_branches:
      - main
      - master
    force_push: "allow"
```

---

## Directory Structure

```
/home/safareli/dev/git-proxy/
├── PLAN.md                 # This file
├── README.md               # User documentation
├── config.example.yaml     # Example configuration
│
├── src/
│   ├── server.py           # HTTP wrapper server (main entry point)
│   ├── git_backend.py      # git-http-backend proxy logic
│   ├── config.py           # Config parsing & validation
│   └── utils.py            # Helpers (locking, git commands, glob matching)
│
├── hooks/
│   └── pre-receive         # Validation + sync push to GitHub
│
├── scripts/
│   ├── init-repos.sh       # Initialize bare repos from config
│   └── entrypoint.sh       # Container entrypoint
│
├── Dockerfile              # Container build
├── docker-compose.yaml     # Example deployment
│
└── tests/
    ├── test_validation.py  # Unit tests for validation logic
    └── test_integration.py # End-to-end tests
```

---

## Components

### 1. HTTP Wrapper Server (`src/server.py`)

**Responsibilities:**
- Listen on HTTP port (default 8080)
- Route requests to appropriate repo
- Acquire per-repo lock before any operation
- Fetch from origin before proxying
- Proxy to git-http-backend

**Pseudo-code:**
```python
from aiohttp import web
import asyncio

# Per-repo locks (read/write lock if needed later)
repo_locks = defaultdict(asyncio.Lock)

async def handle_git_request(request):
    repo_name = extract_repo_name(request.path)
    repo_config = config.repos.get(repo_name)
    
    if not repo_config:
        return web.Response(status=404, text="Repository not found")
    
    async with repo_locks[repo_name]:
        # Fetch latest from origin
        await git_fetch_origin(repo_name)
        
        # Proxy to git-http-backend
        return await proxy_to_git_backend(request, repo_name)

app = web.Application()
app.router.add_route('*', '/{repo_name}.git/{path:.*}', handle_git_request)
```

### 2. Git Backend Proxy (`src/git_backend.py`)

**Responsibilities:**
- Set up environment for git-http-backend
- Execute git-http-backend as subprocess
- Stream request/response

**Key environment variables for git-http-backend:**
```bash
GIT_PROJECT_ROOT=/var/lib/git-proxy/repos
GIT_HTTP_EXPORT_ALL=1
PATH_INFO=/repo.git/info/refs  # from request
QUERY_STRING=service=git-receive-pack  # from request
REQUEST_METHOD=GET  # or POST
CONTENT_TYPE=...  # for POST
```

### 3. Pre-receive Hook (`hooks/pre-receive`)

**Responsibilities:**
- Read ref updates from stdin
- For each ref:
  1. Validate branch name against allowed/blocked patterns
  2. Detect force push, check policy
  3. Check if upstream diverged
  4. Diff against origin/main, check protected paths
  5. If all OK: push to GitHub synchronously
  6. If GitHub push fails: exit 1 (reject)
- Output messages to stderr (sent to agent)

**Pseudo-code:**
```bash
#!/usr/bin/env python3

import sys
import subprocess
import fnmatch

config = load_config()
repo_config = config.repos[REPO_NAME]

def reject(message):
    print(f"remote: ========================================", file=sys.stderr)
    print(f"remote: PUSH REJECTED", file=sys.stderr)
    print(f"remote: ========================================", file=sys.stderr)
    print(f"remote: {message}", file=sys.stderr)
    print(f"remote: ========================================", file=sys.stderr)
    sys.exit(1)

def accept(message):
    print(f"remote: ✓ {message}", file=sys.stderr)

# Read ref updates
for line in sys.stdin:
    old_sha, new_sha, ref_name = line.strip().split()
    branch = ref_name.replace("refs/heads/", "")
    
    # 1. Check branch name
    if not is_branch_allowed(branch, repo_config):
        reject(f"Branch '{branch}' is not allowed")
    
    # 2. Check force push
    if is_force_push(old_sha, new_sha):
        if repo_config.force_push == "deny":
            reject("Force push is not allowed")
    
    # 3. Check upstream divergence
    origin_sha = get_origin_sha(branch)
    if origin_sha and origin_sha != old_sha:
        reject(f"Branch has diverged on upstream. Fetch and rebase.")
    
    # 4. Check protected paths
    changed_files = get_diff_files(f"origin/{repo_config.base_branch}", new_sha)
    violations = check_protected_paths(changed_files, repo_config.protected_paths)
    if violations:
        reject(f"Changes to protected paths:\n" + "\n".join(violations))
    
    # 5. Push to GitHub (synchronous!)
    result = subprocess.run(
        ["git", "push", "origin", f"{new_sha}:refs/heads/{branch}"],
        capture_output=True
    )
    if result.returncode != 0:
        reject(f"Upstream push failed:\n{result.stderr.decode()}")
    
    accept(f"Pushed {branch} to upstream")

sys.exit(0)
```

### 4. Config Module (`src/config.py`)

**Responsibilities:**
- Load and validate config.yaml
- Provide typed access to config

```python
@dataclass
class RepoConfig:
    upstream: str
    protected_paths: list[str]
    allowed_branches: list[str] | None = None
    blocked_branches: list[str] | None = None
    force_push: str = "deny"  # "deny" | "allow"
    base_branch: str = "main"

@dataclass  
class Config:
    repos: dict[str, RepoConfig]
    ssh_key_path: str | None = None

def load_config(path: str) -> Config:
    ...
```

### 5. Init Script (`scripts/init-repos.sh`)

**Responsibilities:**
- Read config
- For each repo:
  - Create bare repo if not exists
  - Set up origin remote
  - Install pre-receive hook
  - Initial fetch

```bash
#!/bin/bash
set -e

REPOS_DIR="/var/lib/git-proxy/repos"
HOOKS_DIR="/app/hooks"

for repo_name in $(yq '.repos | keys | .[]' /etc/git-proxy/config.yaml); do
    upstream=$(yq ".repos.${repo_name}.upstream" /etc/git-proxy/config.yaml)
    repo_path="${REPOS_DIR}/${repo_name}.git"
    
    if [ ! -d "$repo_path" ]; then
        echo "Initializing ${repo_name}..."
        git init --bare "$repo_path"
        git -C "$repo_path" remote add origin "$upstream"
    fi
    
    # Install hook
    cp "${HOOKS_DIR}/pre-receive" "${repo_path}/hooks/pre-receive"
    chmod +x "${repo_path}/hooks/pre-receive"
    
    # Fetch
    echo "Fetching ${repo_name}..."
    git -C "$repo_path" fetch origin
done
```

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
- HTTP server (Python aiohttp) - parses HTTP requests
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

## Deployment

### Environment Variables
```bash
GIT_SSH_KEY         # Private key content for GitHub access
GIT_PROXY_CONFIG    # Path to config (default: /etc/git-proxy/config.yaml)
HTTP_PORT           # Port to listen on (default: 8080)
REPOS_DIR           # Bare repos location (default: /var/lib/git-proxy/repos)
LOG_LEVEL           # debug/info/warn/error (default: info)
```

### Docker
```bash
docker run -d \
  --name git-proxy \
  -e GIT_SSH_KEY="$(cat ~/.ssh/github_deploy_key)" \
  -v ./config.yaml:/etc/git-proxy/config.yaml:ro \
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
      - ./config.yaml:/etc/git-proxy/config.yaml:ro
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
- [ ] Config parsing (`src/config.py`)
- [ ] HTTP server with git-http-backend proxy (`src/server.py`, `src/git_backend.py`)
- [ ] Basic pre-receive hook (branch validation only)
- [ ] Init script (`scripts/init-repos.sh`)
- [ ] Manual testing

### Phase 2: Full Validation
- [ ] Protected path validation in pre-receive
- [ ] Force push detection
- [ ] Upstream divergence check
- [ ] Synchronous push to GitHub
- [ ] Error messages to agent

### Phase 3: Packaging
- [ ] Dockerfile
- [ ] docker-compose.yaml
- [ ] README with usage instructions
- [ ] Example config

### Phase 4: Hardening & Testing
- [ ] Unit tests
- [ ] Integration tests
- [ ] Timeout handling
- [ ] Graceful shutdown
- [ ] Logging
- [ ] Health check endpoint

### Phase 5: Optional Enhancements
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
