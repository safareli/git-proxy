import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig, getRuntimeConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { git, log, setLogLevel } from "./utils.ts";
import { setupSshEnv } from "./server.ts";
import { validateAndPush, parsePreReceiveInput, type PreReceiveContext } from "./hooks.ts";

// ============================================================================
// Repository Initialization
// ============================================================================

async function initializeRepo(
  repoName: string,
  upstream: string,
  reposDir: string,
  sshEnv: Record<string, string>
): Promise<void> {
  const repoPath = join(reposDir, `${repoName}.git`);

  if (existsSync(repoPath)) {
    log.info(`Repo already exists: ${repoPath}`);
    
    // Ensure origin remote is correct
    const result = await git(["remote", "set-url", "origin", upstream], {
      cwd: repoPath,
    });
    if (!result.success) {
      // Remote might not exist, try adding it
      await git(["remote", "add", "origin", upstream], { cwd: repoPath });
    }
  } else {
    log.info(`Initializing bare repo: ${repoPath}`);

    // Create bare repo
    const initResult = await git(["init", "--bare", repoPath]);
    if (!initResult.success) {
      throw new Error(`Failed to init repo ${repoName}: ${initResult.stderr}`);
    }

    // Add origin remote with fetch refspec that puts branches in refs/heads
    // This allows clients to clone and see branches properly
    const addRemoteResult = await git(["remote", "add", "origin", upstream], {
      cwd: repoPath,
    });
    if (!addRemoteResult.success) {
      throw new Error(`Failed to add remote for ${repoName}: ${addRemoteResult.stderr}`);
    }
    
    // Configure fetch refspec to fetch branches to both refs/heads and refs/remotes/origin
    // We need refs/heads for clients to clone, and refs/remotes/origin for our diff comparisons
    await git(["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], {
      cwd: repoPath,
    });
  }

  // Enable http.receivepack for anonymous push (we handle auth/validation ourselves)
  await git(["config", "http.receivepack", "true"], { cwd: repoPath });
  
  // Disable quarantine to allow pushing to upstream from pre-receive hook
  // This is safe because we validate everything in the pre-receive hook before accepting
  await git(["config", "receive.quarantine", "false"], { cwd: repoPath });

  // Install pre-receive hook
  await installPreReceiveHook(repoPath, repoName);

  // Initial fetch
  log.info(`Fetching from upstream: ${upstream}`);
  const fetchResult = await git(["fetch", "origin"], {
    cwd: repoPath,
    env: sshEnv,
  });

  if (!fetchResult.success) {
    throw new Error(`Initial fetch failed for ${repoName}: ${fetchResult.stderr}`);
  }
}

// ============================================================================
// Pre-receive Hook Installation
// ============================================================================

async function installPreReceiveHook(repoPath: string, repoName: string): Promise<void> {
  const hooksDir = join(repoPath, "hooks");
  const hookPath = join(hooksDir, "pre-receive");

  // Ensure hooks directory exists
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  // Get the path to our binary/script
  // Use process.execPath for compiled binaries (gives the actual executable path)
  // For development (.ts files), use process.argv[1] which points to the script
  const selfPath = process.argv[1] ?? Bun.main;
  const isTypeScript = selfPath.endsWith('.ts');
  
  // Determine how to invoke the script
  // For compiled binaries, use process.execPath (the actual path like /usr/local/bin/git-proxy)
  // For .ts files in dev, use bun run with the script path
  const execCommand = isTypeScript 
    ? `bun run "${selfPath}"` 
    : `"${process.execPath}"`;

  // Create hook script that calls our pre-receive subcommand
  const hookScript = `#!/bin/sh
# Git proxy pre-receive hook
# Validates push and forwards to upstream

exec ${execCommand} pre-receive "${repoName}"
`;

  writeFileSync(hookPath, hookScript, { mode: 0o755 });
  log.debug(`Installed pre-receive hook at ${hookPath}`);
}

// ============================================================================
// Pre-receive Hook Handler (called by git as subprocess)
// ============================================================================

async function runPreReceiveHook(repoName: string): Promise<void> {
  // Load config
  const runtimeConfig = getRuntimeConfig();
  setLogLevel(runtimeConfig.logLevel);

  const config = loadConfig(runtimeConfig.configPath);
  const repoConfig = config.repos[repoName];

  if (!repoConfig) {
    console.error(`Unknown repo: ${repoName}`);
    process.exit(1);
  }

  const repoPath = join(runtimeConfig.reposDir, `${repoName}.git`);
  const sshEnv = setupSshEnv(runtimeConfig, config);

  // Read stdin (ref updates from git)
  const stdin = await Bun.stdin.text();
  
  if (!stdin.trim()) {
    // No refs to update
    process.exit(0);
  }

  const updates = parsePreReceiveInput(stdin);

  const ctx: PreReceiveContext = {
    repoPath,
    repoConfig,
    sshEnv,
  };

  const result = await validateAndPush(updates, ctx);

  if (!result.allowed) {
    // Print rejection message to stderr (git shows this to the client)
    console.error(result.message);
    process.exit(1);
  }

  // Success
  console.log(`[git-proxy] Push validated and forwarded to upstream`);
  process.exit(0);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle pre-receive subcommand (called by git hook)
  if (args[0] === "pre-receive") {
    const repoName = args[1];
    if (!repoName) {
      console.error("Usage: git-proxy pre-receive <repo-name>");
      process.exit(1);
    }
    await runPreReceiveHook(repoName);
    return;
  }

  // Normal server startup
  const runtimeConfig = getRuntimeConfig();
  setLogLevel(runtimeConfig.logLevel);

  log.info("Git Proxy starting...");
  log.info(`Config: ${runtimeConfig.configPath}`);
  log.info(`Repos dir: ${runtimeConfig.reposDir}`);

  // Load config
  const config = loadConfig(runtimeConfig.configPath);

  // Create repos directory if needed
  if (!existsSync(runtimeConfig.reposDir)) {
    mkdirSync(runtimeConfig.reposDir, { recursive: true });
  }

  // Setup SSH environment
  const sshEnv = setupSshEnv(runtimeConfig, config);

  // Initialize all configured repos
  for (const [repoName, repoConfig] of Object.entries(config.repos)) {
    log.info(`Initializing repo: ${repoName}`);
    try {
      await initializeRepo(repoName, repoConfig.upstream, runtimeConfig.reposDir, sshEnv);
    } catch (error) {
      log.error(`Failed to initialize repo ${repoName}:`, error);
      throw error;
    }
  }

  // Start HTTP server
  startServer(config, runtimeConfig);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
