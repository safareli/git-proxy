import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ============================================================================
// Test Utilities
// ============================================================================

interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function getHeadShortSha(
  repoPath: string,
  branch: string = "HEAD",
  length: number = 8,
): Promise<string> {
  const result = await git(["rev-parse", `--short=${length}`, branch], {
    cwd: repoPath,
  });
  if (!result.success) {
    throw new Error(`Failed to get HEAD sha: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const normalizeOutput = (_: {
  output: string;
  oldSha?: string;
  newSha?: string;
  port?: number;
}): string => {
  let result = _.output;
  if (_.oldSha) {
    result = result.replace(new RegExp(_.oldSha, "g"), "<OLD_SHA>");
  }
  if (_.newSha) {
    result = result.replace(new RegExp(_.newSha, "g"), "<NEW_SHA>");
  }
  if (_.port) {
    result = result.replace(
      new RegExp(`localhost:${_.port}`, "g"),
      "localhost:<PORT>",
    );
  }
  // Normalize temp directory paths
  result = result.replace(/\/tmp\/git-proxy-test-[^/]+/g, "<TMP_DIR>");
  // Normalize full commit hashes (40 hex chars) and partial hashes (32 hex chars)
  result = result.replace(/[0-9a-f]{40}/g, "<FULL_SHA>");
  result = result.replace(/[0-9a-f]{32}/g, "<PARTIAL_SHA>");
  return result;
};

async function git(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<GitResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, options.env);

  const proc = Bun.spawn(["git", ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { success: exitCode === 0, stdout, stderr, exitCode };
}

async function waitForServer(
  url: string,
  maxAttempts = 30,
  delayMs = 100,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(`Server at ${url} did not become ready`);
}

// ============================================================================
// Test Environment Setup
// ============================================================================

interface TestEnv {
  tmpDir: string;
  upstreamPath: string; // Bare repo simulating GitHub
  proxyReposDir: string; // Where git-proxy stores its repos
  clientPath: string; // Working directory for client
  configPath: string;
  serverProc: Bun.Subprocess | null;
  port: number;
}

async function createTestEnv(port: number): Promise<TestEnv> {
  const tmpDir = mkdtempSync(join(tmpdir(), "git-proxy-test-"));
  const upstreamPath = join(tmpDir, "upstream.git");
  const proxyReposDir = join(tmpDir, "proxy-repos");
  const clientPath = join(tmpDir, "client");
  const configPath = join(tmpDir, "config.json");

  // Create directories
  mkdirSync(proxyReposDir, { recursive: true });
  mkdirSync(clientPath, { recursive: true });

  return {
    tmpDir,
    upstreamPath,
    proxyReposDir,
    clientPath,
    configPath,
    serverProc: null,
    port,
  };
}

async function initUpstreamRepo(env: TestEnv): Promise<void> {
  // Create bare upstream repo
  await git(["init", "--bare", env.upstreamPath]);

  // Create a temporary working dir to make initial commit
  const initDir = join(env.tmpDir, "init-work");
  mkdirSync(initDir);

  await git(["init"], { cwd: initDir });
  await git(["config", "user.email", "test@test.com"], { cwd: initDir });
  await git(["config", "user.name", "Test User"], { cwd: initDir });

  // Create initial files
  writeFileSync(join(initDir, "README.md"), "# Test Project\n");
  mkdirSync(join(initDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(initDir, ".github", "workflows", "ci.yml"), "name: CI\n");

  await git(["add", "."], { cwd: initDir });
  await git(["commit", "-m", "Initial commit"], { cwd: initDir });
  await git(["remote", "add", "origin", env.upstreamPath], { cwd: initDir });
  await git(["push", "-u", "origin", "main"], { cwd: initDir });

  // Clean up init dir
  rmSync(initDir, { recursive: true });
}

async function writeConfig(env: TestEnv, config: object): Promise<void> {
  writeFileSync(env.configPath, JSON.stringify(config, null, 2));
}

async function startProxyServer(env: TestEnv): Promise<void> {
  const indexPath = join(import.meta.dir, "../src/index.ts");

  env.serverProc = Bun.spawn(["bun", "run", indexPath], {
    env: {
      ...process.env,
      GIT_PROXY_CONFIG: env.configPath,
      REPOS_DIR: env.proxyReposDir,
      HTTP_PORT: String(env.port),
      LOG_LEVEL: "debug",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
  await waitForServer(`http://localhost:${env.port}/health`);
}

async function stopProxyServer(env: TestEnv): Promise<void> {
  if (env.serverProc) {
    env.serverProc.kill();
    await env.serverProc.exited;
    env.serverProc = null;
  }
}

async function cleanupTestEnv(env: TestEnv): Promise<void> {
  await stopProxyServer(env);
  if (existsSync(env.tmpDir)) {
    rmSync(env.tmpDir, { recursive: true });
  }
}

async function cloneFromProxy(env: TestEnv, repoName: string): Promise<void> {
  const result = await git(
    ["clone", `http://localhost:${env.port}/${repoName}.git`, "."],
    { cwd: env.clientPath },
  );
  if (!result.success) {
    throw new Error(`Clone failed: ${result.stderr}`);
  }

  // Configure git for commits
  await git(["config", "user.email", "test@test.com"], { cwd: env.clientPath });
  await git(["config", "user.name", "Test User"], { cwd: env.clientPath });
}

// ============================================================================
// Tests
// ============================================================================

describe("Git Proxy Integration Tests", () => {
  let env: TestEnv;
  // Use a random port to avoid conflicts
  const basePort = 18000 + Math.floor(Math.random() * 1000);
  let testPort = basePort;

  beforeEach(async () => {
    testPort++;
    env = await createTestEnv(testPort);
    await initUpstreamRepo(env);
  });

  afterEach(async () => {
    await cleanupTestEnv(env);
  });

  test("push to allowed branch succeeds", async () => {
    // Write config allowing agent/* branches
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*", "feature/*"],
          protected_paths: [".github/**"],
          base_branch: "main",
        },
      },
    });

    // Start proxy server
    await startProxyServer(env);

    // Clone from proxy
    await cloneFromProxy(env, "testproject");

    // Create and push to allowed branch
    await git(["checkout", "-b", "agent/test-feature"], {
      cwd: env.clientPath,
    });
    writeFileSync(join(env.clientPath, "newfile.txt"), "Hello from agent\n");
    await git(["add", "newfile.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Add new file"], { cwd: env.clientPath });

    const pushResult = await git(
      ["push", "-u", "origin", "agent/test-feature"],
      { cwd: env.clientPath },
    );

    expect(pushResult.success).toBe(true);

    // Verify the branch exists in upstream (in a bare repo, we check refs directly)
    const refsResult = await git(
      ["for-each-ref", "--format=%(refname)", "refs/heads/"],
      { cwd: env.upstreamPath },
    );
    expect(refsResult.stdout).toMatchInlineSnapshot(`
        "refs/heads/agent/test-feature
        refs/heads/main
        "
      `);
  });

  test("push to blocked branch fails", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);
    await cloneFromProxy(env, "testproject");

    // Get the current HEAD sha before making changes
    const oldSha = await getHeadShortSha(env.clientPath);

    // Get upstream's main HEAD before the push attempt
    const upstreamMainBefore = await getHeadShortSha(env.upstreamPath, "main");

    // Try to push to main (not in allowed list)
    writeFileSync(join(env.clientPath, "hack.txt"), "malicious content\n");
    await git(["add", "hack.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Hack attempt"], { cwd: env.clientPath });

    // Get the new HEAD sha after commit
    const newSha = await getHeadShortSha(env.clientPath);
    for (const forceArgs of [[], ["--force", "-f"]]) {
      const { stderr, ...rest } = await git(
        ["push", "origin", "main", ...forceArgs],
        {
          cwd: env.clientPath,
        },
      );

      expect(rest).toEqual({
        exitCode: 1,
        stdout: "",
        success: false,
      });
      expect(
        normalizeOutput({ output: stderr, oldSha, newSha, port: env.port }),
      ).toMatchInlineSnapshot(`
      "remote: [WARN] No SSH key configured. Upstream push may fail for private repos.        
      remote: [INFO] Validating: refs/heads/main <OLD_SHA>..<NEW_SHA>        
      remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Branch 'main' is not in allowed list. Allowed patterns: agent/*        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/testproject.git
       ! [remote rejected] main -> main (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/testproject.git'
      "
    `);

      // Verify upstream was NOT modified
      const upstreamMainAfter = await getHeadShortSha(env.upstreamPath, "main");
      expect(upstreamMainAfter).toBe(upstreamMainBefore);
    }
  });

  test("push modifying protected paths fails", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [".github/**"],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);
    await cloneFromProxy(env, "testproject");

    const oldSha = await getHeadShortSha(env.clientPath);

    // Create branch and try to modify protected file
    await git(["checkout", "-b", "agent/sneaky"], { cwd: env.clientPath });
    // The .github/workflows directory should exist from clone, but create if not
    mkdirSync(join(env.clientPath, ".github", "workflows"), {
      recursive: true,
    });
    writeFileSync(
      join(env.clientPath, ".github", "workflows", "ci.yml"),
      "name: HACKED CI\n",
    );
    await git(["add", ".github/workflows/ci.yml"], { cwd: env.clientPath });
    await git(["commit", "-m", "Modify CI workflow"], { cwd: env.clientPath });

    const newSha = await getHeadShortSha(env.clientPath);

    for (const forceArgs of [[], ["--force", "-f"]]) {
      const { stderr, ...rest } = await git(
        ["push", "-u", "origin", "agent/sneaky", ...forceArgs],
        {
          cwd: env.clientPath,
        },
      );

      expect(rest).toEqual({
        exitCode: 1,
        stdout: "",
        success: false,
      });
      expect(
        normalizeOutput({ output: stderr, oldSha, newSha, port: env.port }),
      ).toMatchInlineSnapshot(`
      "remote: [WARN] No SSH key configured. Upstream push may fail for private repos.        
      remote: [INFO] Validating: refs/heads/agent/sneaky 00000000..<NEW_SHA>        
      remote: [DEBUG] git rev-parse --verify origin/main {        
      remote:   cwd: "<TMP_DIR>/proxy-repos/testproject.git",        
      remote: }        
      remote: [DEBUG] git rev-list <NEW_SHA><PARTIAL_SHA> --not origin/main {        
      remote:   cwd: "<TMP_DIR>/proxy-repos/testproject.git",        
      remote: }        
      remote: [DEBUG] New commits being pushed: 1        
      remote: [DEBUG] git diff --name-only origin/main <NEW_SHA><PARTIAL_SHA> {        
      remote:   cwd: "<TMP_DIR>/proxy-repos/testproject.git",        
      remote: }        
      remote: [DEBUG] Files changed in push: .github/workflows/ci.yml        
      remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Changes to protected paths detected:        
      remote:   - .github/workflows/ci.yml        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/testproject.git
       ! [remote rejected] agent/sneaky -> agent/sneaky (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/testproject.git'
      "
    `);

      // Verify the branch was NOT created in upstream
      const branchCheck = await git(["rev-parse", "--verify", "agent/sneaky"], {
        cwd: env.upstreamPath,
      });
      expect(branchCheck.success).toBe(false);
    }
  });

  test("push modifying protected paths then reverting succeeds", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [".github/**"],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);
    await cloneFromProxy(env, "testproject");

    // Create branch and modify protected file
    await git(["checkout", "-b", "agent/revert-test"], { cwd: env.clientPath });
    mkdirSync(join(env.clientPath, ".github", "workflows"), {
      recursive: true,
    });

    // Save original content
    const originalContent = "name: CI\n";

    // First commit: modify protected file
    writeFileSync(
      join(env.clientPath, ".github", "workflows", "ci.yml"),
      "name: MODIFIED CI\n",
    );
    await git(["add", ".github/workflows/ci.yml"], { cwd: env.clientPath });
    await git(["commit", "-m", "Modify CI workflow"], { cwd: env.clientPath });

    // Try to push - should fail because protected file is modified
    const oldSha = await getHeadShortSha(env.clientPath, "HEAD~1");
    const newSha = await getHeadShortSha(env.clientPath);

    for (const forceArgs of [[], ["--force", "-f"]]) {
      const { stderr: firstStderr, ...firstRest } = await git(
        ["push", "-u", "origin", "agent/revert-test", ...forceArgs],
        { cwd: env.clientPath },
      );
      expect(firstRest).toEqual({
        exitCode: 1,
        stdout: "",
        success: false,
      });
      expect(
        normalizeOutput({
          output: firstStderr,
          oldSha,
          newSha,
          port: env.port,
        }),
      ).toMatchInlineSnapshot(`
        "remote: [WARN] No SSH key configured. Upstream push may fail for private repos.        
        remote: [INFO] Validating: refs/heads/agent/revert-test 00000000..<NEW_SHA>        
        remote: [DEBUG] git rev-parse --verify origin/main {        
        remote:   cwd: "<TMP_DIR>/proxy-repos/testproject.git",        
        remote: }        
        remote: [DEBUG] git rev-list <NEW_SHA><PARTIAL_SHA> --not origin/main {        
        remote:   cwd: "<TMP_DIR>/proxy-repos/testproject.git",        
        remote: }        
        remote: [DEBUG] New commits being pushed: 1        
        remote: [DEBUG] git diff --name-only origin/main <NEW_SHA><PARTIAL_SHA> {        
        remote:   cwd: "<TMP_DIR>/proxy-repos/testproject.git",        
        remote: }        
        remote: [DEBUG] Files changed in push: .github/workflows/ci.yml        
        remote: 
        remote: ==================================================        
        remote: PUSH REJECTED        
        remote: ==================================================        
        remote: Changes to protected paths detected:        
        remote:   - .github/workflows/ci.yml        
        remote: ==================================================        
        remote: 
        To http://localhost:<PORT>/testproject.git
         ! [remote rejected] agent/revert-test -> agent/revert-test (pre-receive hook declined)
        error: failed to push some refs to 'http://localhost:<PORT>/testproject.git'
        "
      `);

      // Verify the branch was NOT created in upstream after rejection
      const branchCheckAfterRejection = await git(
        ["rev-parse", "--verify", "agent/revert-test"],
        { cwd: env.upstreamPath },
      );
      expect(branchCheckAfterRejection.success).toBe(false);
    }

    // Second commit: revert the change back to original
    writeFileSync(
      join(env.clientPath, ".github", "workflows", "ci.yml"),
      originalContent,
    );
    await git(["add", ".github/workflows/ci.yml"], { cwd: env.clientPath });
    await git(["commit", "-m", "Revert CI workflow change"], {
      cwd: env.clientPath,
    });

    // Also add a non-protected file so we have actual changes
    writeFileSync(join(env.clientPath, "newfile.txt"), "New file content\n");
    await git(["add", "newfile.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Add new file"], { cwd: env.clientPath });

    // Now push should succeed because net diff has no protected path changes
    const secondPushResult = await git(
      ["push", "-u", "origin", "agent/revert-test"],
      { cwd: env.clientPath },
    );

    expect(secondPushResult.success).toBe(true);

    // Verify the branch exists in upstream after successful push
    const refsResult = await git(
      ["for-each-ref", "--format=%(refname)", "refs/heads/agent/revert-test"],
      { cwd: env.upstreamPath },
    );
    expect(refsResult.stdout.trim()).toBe("refs/heads/agent/revert-test");
  });

  test("force push is denied by default", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);
    await cloneFromProxy(env, "testproject");

    // Create and push initial branch with TWO commits
    await git(["checkout", "-b", "agent/force-test"], { cwd: env.clientPath });
    writeFileSync(join(env.clientPath, "file1.txt"), "Version 1\n");
    await git(["add", "file1.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "First commit"], { cwd: env.clientPath });

    writeFileSync(join(env.clientPath, "file1.txt"), "Version 2\n");
    await git(["add", "file1.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Second commit"], { cwd: env.clientPath });

    // Push both commits
    await git(["push", "-u", "origin", "agent/force-test"], {
      cwd: env.clientPath,
    });

    // Get the old SHA (what's on remote, i.e., second commit)
    const oldSha = await getHeadShortSha(env.clientPath);
    const upstreamBranchBefore = await getHeadShortSha(
      env.upstreamPath,
      "agent/force-test",
    );

    // Now reset back to first commit (removes second commit)
    await git(["reset", "--hard", "HEAD~1"], { cwd: env.clientPath });

    // Make a DIFFERENT second commit (divergent from what's on remote)
    writeFileSync(join(env.clientPath, "file1.txt"), "Different Version 2\n");
    await git(["add", "file1.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Different second commit"], {
      cwd: env.clientPath,
    });

    const newSha = await getHeadShortSha(env.clientPath);

    // Try to force push - should fail because force_push: "deny" (default)
    const { stderr, ...rest } = await git(
      ["push", "--force", "origin", "agent/force-test"],
      { cwd: env.clientPath },
    );

    expect(rest).toEqual({
      exitCode: 1,
      stdout: "",
      success: false,
    });
    expect(normalizeOutput({ output: stderr, oldSha, newSha, port: env.port }))
      .toMatchInlineSnapshot(`
      "remote: [WARN] No SSH key configured. Upstream push may fail for private repos.        
      remote: [INFO] Validating: refs/heads/agent/force-test <OLD_SHA>..<NEW_SHA>        
      remote: [DEBUG] git merge-base --is-ancestor <OLD_SHA><PARTIAL_SHA> <NEW_SHA><PARTIAL_SHA> {        
      remote:   cwd: "<TMP_DIR>/proxy-repos/testproject.git",        
      remote: }        
      remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Force push detected and not allowed. Old: <OLD_SHA>, New: <NEW_SHA>        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/testproject.git
       ! [remote rejected] agent/force-test -> agent/force-test (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/testproject.git'
      "
    `);

    // Verify upstream was NOT modified (should still be at the old commit)
    const upstreamBranchAfter = await getHeadShortSha(
      env.upstreamPath,
      "agent/force-test",
    );
    expect(upstreamBranchAfter).toBe(upstreamBranchBefore);
  });

  test("force push is allowed when configured", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
          force_push: "allow",
        },
      },
    });

    await startProxyServer(env);
    await cloneFromProxy(env, "testproject");

    // Create and push initial branch with TWO commits
    await git(["checkout", "-b", "agent/force-test"], { cwd: env.clientPath });
    writeFileSync(join(env.clientPath, "file1.txt"), "Version 1\n");
    await git(["add", "file1.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "First commit"], { cwd: env.clientPath });

    writeFileSync(join(env.clientPath, "file1.txt"), "Version 2\n");
    await git(["add", "file1.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Second commit"], { cwd: env.clientPath });

    // Push both commits
    await git(["push", "-u", "origin", "agent/force-test"], {
      cwd: env.clientPath,
    });

    // Reset back to first commit and make different change
    await git(["reset", "--hard", "HEAD~1"], { cwd: env.clientPath });
    writeFileSync(join(env.clientPath, "file1.txt"), "Different content\n");
    await git(["add", "file1.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Rewritten history"], { cwd: env.clientPath });

    // Force push should succeed because force_push: "allow"
    const pushResult = await git(
      ["push", "--force", "origin", "agent/force-test"],
      { cwd: env.clientPath },
    );
    expect(pushResult.success).toBe(true);
  });

  test("clone and fetch work correctly", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);

    // Clone should work
    const cloneResult = await git(
      ["clone", `http://localhost:${env.port}/testproject.git`, "."],
      { cwd: env.clientPath },
    );
    expect(cloneResult.success).toBe(true);

    // Verify content
    expect(existsSync(join(env.clientPath, "README.md"))).toBe(true);

    // Fetch should also work
    const fetchResult = await git(["fetch", "origin"], { cwd: env.clientPath });
    expect(fetchResult.success).toBe(true);
  });

  test("clone checks out base_branch by default", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);

    // Clone from proxy
    const cloneResult = await git(
      ["clone", `http://localhost:${env.port}/testproject.git`, "."],
      { cwd: env.clientPath },
    );
    expect(cloneResult.success).toBe(true);

    // Verify we're on the base_branch (main)
    const branchResult = await git(["branch", "--show-current"], {
      cwd: env.clientPath,
    });
    expect(branchResult.success).toBe(true);
    expect(branchResult.stdout.trim()).toBe("main");
  });

  test("push to unknown repo fails", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);

    // Try to clone unknown repo
    const { stderr, ...rest } = await git(
      ["clone", `http://localhost:${env.port}/unknown.git`, "."],
      { cwd: env.clientPath },
    );

    expect(rest).toEqual({
      exitCode: 128,
      stdout: "",
      success: false,
    });
    expect(normalizeOutput({ output: stderr, port: env.port }))
      .toMatchInlineSnapshot(`
      "Cloning into '.'...
      remote: Not Found - Unknown repo: unknown
      fatal: repository 'http://localhost:<PORT>/unknown.git/' not found
      "
    `);
  });

  test("blocked_branches config works", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          blocked_branches: ["main", "master", "release/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);
    await cloneFromProxy(env, "testproject");

    // Push to non-blocked branch should work
    await git(["checkout", "-b", "feature/my-feature"], {
      cwd: env.clientPath,
    });
    writeFileSync(join(env.clientPath, "feature.txt"), "New feature\n");
    await git(["add", "feature.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Add feature"], { cwd: env.clientPath });

    const pushResult = await git(
      ["push", "-u", "origin", "feature/my-feature"],
      { cwd: env.clientPath },
    );
    expect(pushResult.success).toBe(true);

    // Push to blocked branch should fail
    await git(["checkout", "main"], { cwd: env.clientPath });

    const upstreamMainBefore = await getHeadShortSha(env.upstreamPath, "main");

    writeFileSync(join(env.clientPath, "main-change.txt"), "Change on main\n");
    await git(["add", "main-change.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Change main"], { cwd: env.clientPath });

    const oldSha = await getHeadShortSha(env.clientPath, "HEAD~1");
    const newSha = await getHeadShortSha(env.clientPath);

    for (const forceArgs of [[], ["--force", "-f"]]) {
      const { stderr, ...rest } = await git(
        ["push", "origin", "main", ...forceArgs],
        {
          cwd: env.clientPath,
        },
      );

      expect(rest).toEqual({
        exitCode: 1,
        stdout: "",
        success: false,
      });
      expect(
        normalizeOutput({ output: stderr, oldSha, newSha, port: env.port }),
      ).toMatchInlineSnapshot(`
      "remote: [WARN] No SSH key configured. Upstream push may fail for private repos.        
      remote: [INFO] Validating: refs/heads/main <OLD_SHA>..<NEW_SHA>        
      remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Branch 'main' is blocked. Blocked patterns: main, master, release/*        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/testproject.git
       ! [remote rejected] main -> main (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/testproject.git'
      "
    `);

      // Verify upstream main was NOT modified
      const upstreamMainAfter = await getHeadShortSha(env.upstreamPath, "main");
      expect(upstreamMainAfter).toBe(upstreamMainBefore);
    }
  });

  test("proxy fetches upstream changes before serving", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);

    // First, clone from proxy
    await cloneFromProxy(env, "testproject");

    // Now simulate someone pushing directly to upstream (e.g., via GitHub web UI)
    // We do this by pushing to the bare upstream repo directly
    const directPushDir = join(env.tmpDir, "direct-push");
    mkdirSync(directPushDir);
    await git(["clone", env.upstreamPath, "."], { cwd: directPushDir });
    await git(["config", "user.email", "other@test.com"], {
      cwd: directPushDir,
    });
    await git(["config", "user.name", "Other User"], { cwd: directPushDir });

    // Create a new file and push directly to upstream
    writeFileSync(
      join(directPushDir, "upstream-change.txt"),
      "Change made directly on GitHub\n",
    );
    await git(["add", "upstream-change.txt"], { cwd: directPushDir });
    await git(["commit", "-m", "Direct upstream change"], {
      cwd: directPushDir,
    });
    const directPush = await git(["push", "origin", "main"], {
      cwd: directPushDir,
    });
    expect(directPush.success).toBe(true);

    // Now fetch from proxy - it should fetch from upstream first and serve the new commit
    const fetchResult = await git(["fetch", "origin"], { cwd: env.clientPath });
    expect(fetchResult.success).toBe(true);

    // Check that the new commit is visible
    const logResult = await git(["log", "origin/main", "--oneline"], {
      cwd: env.clientPath,
    });
    expect(logResult.stdout).toContain("Direct upstream change");

    // Pull and verify the file exists
    await git(["pull", "origin", "main"], { cwd: env.clientPath });
    expect(existsSync(join(env.clientPath, "upstream-change.txt"))).toBe(true);
  });

  test("health endpoint works", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);

    const response = await fetch(`http://localhost:${env.port}/health`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toEqual({ status: "ok" });
  });

  test("push tags is blocked", async () => {
    await writeConfig(env, {
      repos: {
        testproject: {
          upstream: env.upstreamPath,
          allowed_branches: ["agent/*"],
          protected_paths: [],
          base_branch: "main",
        },
      },
    });

    await startProxyServer(env);
    await cloneFromProxy(env, "testproject");

    // Create a branch with a commit
    await git(["checkout", "-b", "agent/tagging"], { cwd: env.clientPath });
    writeFileSync(join(env.clientPath, "release.txt"), "Release v1.0\n");
    await git(["add", "release.txt"], { cwd: env.clientPath });
    await git(["commit", "-m", "Release v1.0"], { cwd: env.clientPath });

    // Push the branch (should succeed)

    const branchPush = await git(["push", "-u", "origin", "agent/tagging"], {
      cwd: env.clientPath,
    });
    expect(branchPush.success).toBe(true);

    // Create a tag (annotated tag creates a tag object)
    await git(["tag", "-a", "v1.0", "-m", "Version 1.0"], {
      cwd: env.clientPath,
    });

    // Get the SHA of the tag object (not the commit it points to)
    const newSha = await getHeadShortSha(env.clientPath, "v1.0", 8);

    // Try to push the tag (should fail even with force)
    for (const forceArgs of [[], ["--force", "-f"]]) {
      const { stderr, ...rest } = await git(
        ["push", "origin", "v1.0", ...forceArgs],
        {
          cwd: env.clientPath,
        },
      );

      expect(rest).toEqual({
        exitCode: 1,
        stdout: "",
        success: false,
      });
      expect(normalizeOutput({ output: stderr, newSha, port: env.port }))
        .toMatchInlineSnapshot(`
      "remote: [WARN] No SSH key configured. Upstream push may fail for private repos.        
      remote: [INFO] Validating: refs/tags/v1.0 00000000..<NEW_SHA>        
      remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Only branch pushes allowed (refs/heads/*), got: refs/tags/v1.0        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/testproject.git
       ! [remote rejected] v1.0 -> v1.0 (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/testproject.git'
      "
    `);

      // Verify the tag was NOT created in upstream
      const tagCheck = await git(["tag", "-l", "v1.0"], {
        cwd: env.upstreamPath,
      });
      expect(tagCheck.stdout.trim()).toBe("");
    }
  });
});
