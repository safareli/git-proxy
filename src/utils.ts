// Using Bun.spawn from global Bun namespace

// ============================================================================
// Utilities
// ============================================================================

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Logging
// ============================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

export const log = {
  debug: (msg: string, ...args: unknown[]) => {
    if (shouldLog("debug")) console.log(`[DEBUG] ${msg}`, ...args);
  },
  info: (msg: string, ...args: unknown[]) => {
    if (shouldLog("info")) console.log(`[INFO] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (shouldLog("warn")) console.warn(`[WARN] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    if (shouldLog("error")) console.error(`[ERROR] ${msg}`, ...args);
  },
};

// ============================================================================
// Per-Repo Locking
// ============================================================================

const locks = new Map<string, Promise<void>>();

export async function withLock<T>(
  repoName: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Wait for any existing lock on this repo
  while (locks.has(repoName)) {
    await locks.get(repoName);
  }

  // Create our lock
  let resolve: () => void;
  locks.set(
    repoName,
    new Promise<void>((r) => {
      resolve = r;
    }),
  );

  try {
    return await fn();
  } finally {
    locks.delete(repoName);
    resolve!();
  }
}

// ============================================================================
// Git Command Helpers
// ============================================================================

export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function git(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    /** If true, env replaces process.env entirely instead of merging */
    fullEnv?: boolean;
  } = {},
): Promise<GitResult> {
  const { cwd, env, fullEnv = false } = options;

  log.debug(`git ${args.join(" ")}`, { cwd });

  let finalEnv: Record<string, string>;
  if (fullEnv) {
    finalEnv = env ?? {};
  } else {
    finalEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        finalEnv[key] = value;
      }
    }
    Object.assign(finalEnv, env);
  }

  const proc = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    env: finalEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    success: exitCode === 0,
    stdout,
    stderr,
    exitCode,
  };
}

// ============================================================================
// Glob Pattern Matching (for protected paths)
// ============================================================================

import { Glob } from "bun";

/**
 * Check if a path matches any of the glob patterns
 */
export function matchesAnyPattern(
  path: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    // Handle trailing slash - means directory and contents
    // Convert "nix/" to "nix/**" to match all contents
    let normalizedPattern = pattern;
    if (pattern.endsWith("/") && !pattern.endsWith("**/")) {
      normalizedPattern = pattern.slice(0, -1) + "/**";
    }

    const glob = new Glob(normalizedPattern);
    // Also match the directory itself (without trailing slash) or with contents
    return (
      glob.match(path) ||
      (pattern.endsWith("/") && new Glob(pattern.slice(0, -1)).match(path))
    );
  });
}

/**
 * Check if a branch name matches any of the glob patterns
 */
export function branchMatchesPattern(
  branch: string,
  patterns: readonly string[],
): boolean {
  // Remove refs/heads/ prefix if present
  const branchName = branch.replace(/^refs\/heads\//, "");
  return matchesAnyPattern(branchName, patterns);
}
