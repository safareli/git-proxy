import { join } from "path";
import type { Config, RuntimeConfig } from "./config.ts";
import {
  createGitBackendRequest,
  executeGitHttpBackend,
} from "./git-backend.ts";
import { git, log, withLock } from "./utils.ts";

// ============================================================================
// Server State
// ============================================================================

interface ServerState {
  config: Config;
  runtimeConfig: RuntimeConfig;
  sshEnv: Record<string, string>;
}

// ============================================================================
// SSH Environment Setup
// ============================================================================

export function setupSshEnv(
  runtimeConfig: RuntimeConfig,
  config: Config,
): Record<string, string> {
  const sshKeyPath = runtimeConfig.sshKeyPath ?? config.ssh_key_path;

  // Check if SSH is configured either via our config or system environment
  // GIT_SSH_COMMAND can be pre-set in the environment to use a custom SSH setup
  if (!sshKeyPath && !process.env["GIT_SSH_COMMAND"]) {
    log.warn(
      "No SSH key configured. Upstream push may fail for private repos.",
    );
    return {};
  }

  if (sshKeyPath) {
    // Create SSH command that uses the specified key
    // GIT_SSH_COMMAND: An environment variable that Git uses to override the SSH command
    // when connecting to remote repositories over SSH protocol (e.g., git@github.com:user/repo.git)
    // This allows us to:
    // - Specify a custom SSH key with -i flag
    // - Auto-accept new host keys with StrictHostKeyChecking=accept-new
    // - Use a null known_hosts file to avoid persisting host keys
    const sshCommand = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`;
    return { GIT_SSH_COMMAND: sshCommand };
  }

  return {};
}

// ============================================================================
// Request Routing
// ============================================================================

export function parseRepoFromPath(
  pathname: string,
): { repoName: string; subPath: string } | null {
  // Expected format: /<repo-name>.git/<sub-path>
  // or /<repo-name>.git
  // Repo names can include slashes for namespacing, e.g., "user/project"
  // Use non-greedy matching (.+?) to find the first .git boundary
  const match = pathname.match(/^\/(.+?)\.git(\/.*)?$/);
  if (!match) {
    return null;
  }

  const repoName = match[1];
  const subPath = match[2] ?? "";

  if (!repoName) {
    return null;
  }

  return { repoName, subPath };
}

// ============================================================================
// Repo Operations
// ============================================================================

async function fetchFromOrigin(
  repoPath: string,
  sshEnv: Record<string, string>,
): Promise<void> {
  log.info(`Fetching from origin: ${repoPath}`);

  const result = await git(["fetch", "origin", "--prune"], {
    cwd: repoPath,
    env: sshEnv,
  });

  if (!result.success) {
    log.error(`Failed to fetch from origin: ${result.stderr}`);
    throw new Error(`Failed to fetch from origin: ${result.stderr}`);
  }
}

function getRepoPath(runtimeConfig: RuntimeConfig, repoName: string): string {
  return join(runtimeConfig.reposDir, `${repoName}.git`);
}

// ============================================================================
// Request Handler
// ============================================================================

async function handleGitRequest(
  request: Request,
  state: ServerState,
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseRepoFromPath(url.pathname);

  if (!parsed) {
    return new Response("Not Found - Invalid repo path\n", { status: 404 });
  }

  const { repoName } = parsed;

  // Check if repo is configured
  const repoConfig = state.config.repos[repoName];
  if (!repoConfig) {
    log.warn(`Unknown repo requested: ${repoName}`);
    return new Response(`Not Found - Unknown repo: ${repoName}\n`, {
      status: 404,
    });
  }

  const repoPath = getRepoPath(state.runtimeConfig, repoName);

  log.info(`Request: ${request.method} ${url.pathname} -> ${repoName}`);

  // Acquire per-repo lock and process request
  return withLock(repoName, async () => {
    // Fetch from origin before any operation
    try {
      await fetchFromOrigin(repoPath, state.sshEnv);
    } catch (error) {
      log.error(`Fetch failed for ${repoName}:`, error);
      return new Response(`Internal Error - Failed to sync with upstream\n`, {
        status: 500,
      });
    }

    // Proxy to git-http-backend
    const gitRequest = createGitBackendRequest(request, repoPath, repoName);
    return executeGitHttpBackend(gitRequest);
  });
}

// ============================================================================
// Health Check
// ============================================================================

function handleHealthCheck(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// Main Server
// ============================================================================

export function createServer(
  config: Config,
  runtimeConfig: RuntimeConfig,
): { fetch: (request: Request) => Promise<Response> } {
  const sshEnv = setupSshEnv(runtimeConfig, config);
  const state: ServerState = { config, runtimeConfig, sshEnv };

  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      // Health check endpoint
      if (url.pathname === "/health" || url.pathname === "/healthz") {
        return handleHealthCheck();
      }

      // Git requests
      try {
        return await handleGitRequest(request, state);
      } catch (error) {
        log.error("Request error:", error);
        return new Response("Internal Server Error\n", { status: 500 });
      }
    },
  };
}

export function startServer(
  config: Config,
  runtimeConfig: RuntimeConfig,
): void {
  const server = createServer(config, runtimeConfig);

  Bun.serve({
    port: runtimeConfig.httpPort,
    fetch: server.fetch,
  });

  log.info(`Git proxy server started on port ${runtimeConfig.httpPort}`);
  log.info(`Configured repos: ${Object.keys(config.repos).join(", ")}`);
}
