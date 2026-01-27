# Git Proxy

A secure git proxy that enables untrusted agents (AI coding assistants, CI runners, etc.) to interact with GitHub repositories safely. The proxy validates all operations before forwarding them to GitHub, enforcing branch restrictions and protecting sensitive files.

## Why?

AI coding agents are powerful but need guardrails. You want them to:
- ✅ Write code and push to feature branches
- ✅ Open pull requests for review
- ✅ See CI results and fix failures
- ❌ Push directly to `main`
- ❌ Modify CI workflows (supply chain attacks)
- ❌ Change sensitive configuration files
- ❌ Delete repositories or branches

Git Proxy provides these guardrails at the git protocol level, before changes ever reach GitHub.

---

## Maximum Security Setup

The most secure setup combines **three layers of defense**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        DEFENSE IN DEPTH                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Layer 1: Git Proxy (this project)                                      │
│  ─────────────────────────────────                                      │
│  • Validates BEFORE GitHub sees anything                                │
│  • Branch restrictions (whitelist: agent/*, feature/*)                  │
│  • Protected paths (.github/**, *.nix, Makefile, etc.)                  │
│  • Force push prevention                                                │
│  • Synchronous validation with clear error messages                     │
│                                                                         │
│  Layer 2: GitHub Fine-Grained Personal Access Token                     │
│  ──────────────────────────────────────────────────                     │
│  • Minimal permissions for the task                                     │
│  • Scoped to specific repositories                                      │
│  • Cannot access admin/settings/delete operations                       │
│  • Time-limited expiration                                              │
│                                                                         │
│  Layer 3: GitHub Branch Protection Rules                                │
│  ────────────────────────────────────────                               │
│  • Require PR for merging to main                                       │
│  • Require CI to pass                                                   │
│  • Require human approval                                               │
│  • Server-side enforcement (cannot be bypassed)                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Layer 1: Git Proxy Configuration

```json
{
  "repos": {
    "myproject": {
      "upstream": "git@github.com:myorg/myproject.git",
      
      "allowed_branches": [
        "agent/*",
        "ai/*",
        "feature/*"
      ],
      
      "protected_paths": [
        ".github/**",
        ".gitlab-ci.yml",
        "Jenkinsfile",
        "*.nix",
        "flake.lock",
        "nix/**",
        "Makefile",
        "Dockerfile",
        "docker-compose*.yml",
        ".env*",
        "config/secrets/**",
        "*.pem",
        "*.key"
      ],
      
      "force_push": "deny",
      "base_branch": "main"
    }
  }
}
```

### Layer 2: Fine-Grained PAT Configuration

Create a [fine-grained personal access token](https://github.blog/security/application-security/introducing-fine-grained-personal-access-tokens-for-github/) with minimal permissions:

| Permission | Access | Purpose |
|------------|--------|---------|
| **Contents** | Read | Read repo contents (for PR diffs) |
| **Pull requests** | Write | Open/update PRs |
| **Actions** | Read | View CI run results and logs |
| **Metadata** | Read | Required (automatic) |

**Why no Contents:Write?**
- All git push operations go through the **Git Proxy** (which has its own SSH key)
- The agent's PAT is only used for **GitHub API** calls (PRs, CI status)
- This prevents the agent from bypassing the proxy by pushing directly to GitHub

**Do NOT grant:**
- Contents: Write (use proxy for pushes!)
- Administration
- Workflows (prevents `.github/workflows` modification via API)
- Environments
- Secrets
- Pages
- Any "delete" capabilities

**Additional settings:**
- Scope to **specific repositories only**
- Set **expiration date** (30-90 days recommended)
- Use **organization-level token** if available (better audit trail)

### Layer 3: GitHub Branch Protection

Go to Repository → Settings → Branches → Add rule for `main`:

- [x] **Require a pull request before merging**
  - [x] Require approvals: 1 (or more)
  - [x] Dismiss stale PR approvals when new commits are pushed
- [x] **Require status checks to pass before merging**
  - Select your CI workflow(s)
- [x] **Require conversation resolution before merging**
- [x] **Do not allow bypassing the above settings**
- [x] **Restrict who can push to matching branches**
  - Only allow specific teams/users (not the agent's token)

---

## Threat Model & Mitigations

### Threats Addressed

| Threat | Risk | Mitigation |
|--------|------|------------|
| **Direct push to main** | Agent ships unreviewed code | Branch restrictions (proxy) + branch protection (GitHub) |
| **Bypass proxy via API** | Agent pushes directly to GitHub, skipping validation | PAT has no `Contents:Write` permission |
| **CI/CD poisoning** | Agent modifies workflows to exfiltrate secrets or run malicious code | Protected paths block `.github/**` |
| **Supply chain attack** | Agent modifies build configs (Dockerfile, nix, Makefile) | Protected paths block build files |
| **Secret exfiltration** | Agent reads/modifies secrets | Protected paths + no secrets permission on PAT |
| **Repository deletion** | Agent deletes repo or branches | PAT has no delete permissions |
| **Settings modification** | Agent changes repo settings, webhooks | PAT has no admin permissions |
| **Force push history rewrite** | Agent rewrites git history | Force push denied by proxy |
| **Credential theft** | Agent steals proxy credentials | SSH key only accessible to proxy, not agent |
| **Lateral movement** | Agent accesses other repos | PAT scoped to specific repos only |
| **Persistent access** | Compromised agent maintains access | PAT has expiration date |

### Threats NOT Addressed (Require Additional Measures)

| Threat | Additional Mitigation Needed |
|--------|------------------------------|
| **Malicious code in PR** | Human review before merge |
| **Subtle backdoors** | Code review + security scanning |
| **Resource abuse** | Rate limiting, compute quotas |
| **Data exfiltration via code** | Network isolation, egress filtering |
| **Compromised dependencies** | Dependency scanning, lockfile review |

---

## Agent Workflow

With this setup, an agent can work autonomously within safe boundaries:

```
┌──────────────────────────────────────────────────────────────────┐
│                     AGENT WORKFLOW                               │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Clone via Proxy │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Create branch   │
                    │  agent/feature-x │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Write code      │
                    │  (no protected   │
                    │   files)         │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Push via Proxy  │──────┐
                    └────────┬─────────┘      │
                             │                │ Rejected?
                             │ OK             │ Fix & retry
                             ▼                │
                    ┌──────────────────┐      │
                    │  Open PR via     │◀─────┘
                    │  GitHub API      │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  CI runs         │
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
     ┌────────────────┐           ┌────────────────┐
     │  CI passes     │           │  CI fails      │
     └───────┬────────┘           └───────┬────────┘
             │                            │
             ▼                            ▼
     ┌────────────────┐           ┌────────────────┐
     │  Await human   │           │  Read errors   │
     │  review        │           │  via API       │
     └───────┬────────┘           └───────┬────────┘
             │                            │
             ▼                            ▼
     ┌────────────────┐           ┌────────────────┐
     │  Human merges  │           │  Fix & push    │
     │  to main       │           │  (loop back)   │
     └────────────────┘           └────────────────┘
```

### Example Agent Commands

```bash
# Clone repository through proxy
git clone http://git-proxy:8080/myproject.git
cd myproject

# Create feature branch (must match allowed pattern)
git checkout -b agent/add-user-auth

# Make changes (proxy will reject if touching protected files)
echo "def login(): pass" >> auth.py
git add auth.py
git commit -m "feat: add user authentication"

# Push through proxy
git push origin agent/add-user-auth
# → Proxy validates branch name ✓
# → Proxy validates no protected paths changed ✓
# → Proxy pushes to GitHub ✓

# Open PR using GitHub API (with fine-grained PAT)
gh pr create --title "Add user authentication" --body "..."

# Check CI status
gh run list --branch agent/add-user-auth
gh run view <run-id> --log-failed

# If CI fails, fix and push again
# ... make fixes ...
git push origin agent/add-user-auth
```

---

## Deployment

### Quick Start with Docker

```bash
# 1. Create configuration
cat > config.json << 'EOF'
{
  "repos": {
    "myproject": {
      "upstream": "git@github.com:myorg/myproject.git",
      "allowed_branches": ["agent/*", "feature/*"],
      "protected_paths": [".github/**", "*.nix", "Dockerfile"],
      "force_push": "deny",
      "base_branch": "main"
    }
  }
}
EOF

# 2. Run proxy
docker run -d \
  --name git-proxy \
  -p 8080:8080 \
  -e GIT_SSH_KEY="$(cat ~/.ssh/github_deploy_key)" \
  -v $(pwd)/config.json:/etc/git-proxy/config.json:ro \
  git-proxy:latest

# 3. Configure agent to use proxy
git clone http://localhost:8080/myproject.git
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
      - LOG_LEVEL=info
    secrets:
      - github_ssh_key
    restart: unless-stopped

volumes:
  repos:

secrets:
  github_ssh_key:
    file: ./github_deploy_key
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_SSH_KEY` | - | GitHub SSH private key (content) |
| `GIT_SSH_KEY_FILE` | - | Path to SSH private key file |
| `GIT_PROXY_CONFIG` | `/etc/git-proxy/config.json` | Configuration file path |
| `HTTP_PORT` | `8080` | HTTP server port |
| `REPOS_DIR` | `/var/lib/git-proxy/repos` | Bare repository storage |
| `LOG_LEVEL` | `info` | Logging verbosity |

---

## Security Checklist

Before deploying, verify:

### Git Proxy
- [ ] Configuration uses `allowed_branches` (whitelist), not `blocked_branches`
- [ ] All sensitive paths are in `protected_paths`
- [ ] `force_push` is set to `deny`
- [ ] Proxy runs in isolated container/VM
- [ ] SSH key has minimal permissions (deploy key, not user key)

### Fine-Grained PAT
- [ ] Token scoped to specific repositories
- [ ] Only `Contents:Read`, `Pull requests:Write`, `Actions:Read` granted
- [ ] **No `Contents:Write`** (prevents bypassing proxy)
- [ ] No admin, delete, workflows, or secrets permissions
- [ ] Expiration date is set
- [ ] Token stored securely in agent environment (separate from proxy's SSH key)

### GitHub Repository
- [ ] Branch protection enabled on `main`
- [ ] PR required for merging
- [ ] At least one approval required
- [ ] Status checks required
- [ ] "Do not allow bypassing" enabled

### Network
- [ ] Proxy only accessible from agent network
- [ ] Agent cannot reach GitHub directly (optional, extra security)
- [ ] Egress filtering if possible

---

## Error Messages

When the proxy rejects a push, the agent sees clear error messages:

```
remote: ════════════════════════════════════════════════════════════
remote: PUSH REJECTED
remote: ════════════════════════════════════════════════════════════
remote: 
remote: Branch not allowed: refs/heads/main
remote: 
remote: Allowed patterns:
remote:   - agent/*
remote:   - feature/*
remote: 
remote: Please push to an allowed branch, e.g.:
remote:   git push origin agent/my-feature
remote: 
remote: ════════════════════════════════════════════════════════════
```

```
remote: ════════════════════════════════════════════════════════════
remote: PUSH REJECTED
remote: ════════════════════════════════════════════════════════════
remote: 
remote: Protected paths modified:
remote:   - .github/workflows/ci.yml
remote:   - Dockerfile
remote: 
remote: These files cannot be modified by this proxy.
remote: Please remove these changes and try again.
remote: 
remote: ════════════════════════════════════════════════════════════
```

---

## Comparison with Alternatives

| Approach | Branch Control | Path Protection | Credential Isolation | Offline Validation |
|----------|---------------|-----------------|---------------------|-------------------|
| **Git Proxy** | ✅ | ✅ | ✅ | ✅ |
| PAT only | ❌ | ❌ | ❌ | ❌ |
| Branch protection only | ✅ | ❌ | ❌ | ❌ |
| Git hooks (client-side) | ❌ Bypassable | ❌ Bypassable | ❌ | ❌ |
| GitHub Actions validation | ✅ | ✅ | ❌ | ❌ After push |

Git Proxy is the only solution that validates **before** data reaches GitHub and provides **credential isolation** (agent never sees the GitHub token).

---

## License

MIT
