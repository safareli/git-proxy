import type { RepoConfig } from "./config.ts";
import { git, log, branchMatchesPattern, matchesAnyPattern } from "./utils.ts";

// ============================================================================
// Types
// ============================================================================

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  refName: string;
}

export interface ValidationResult {
  allowed: boolean;
  message: string;
  /** For force push validation, indicates if this is actually a force push */
  isForcePush?: boolean;
}

// ============================================================================
// Branch Validation
// ============================================================================

export function validateBranch(refName: string, config: RepoConfig): ValidationResult {
  // Only validate branch refs
  if (!refName.startsWith("refs/heads/")) {
    return {
      allowed: false,
      message: `Only branch pushes allowed (refs/heads/*), got: ${refName}`,
    };
  }

  const branchName = refName.replace(/^refs\/heads\//, "");

  if (config.allowed_branches) {
    if (!branchMatchesPattern(branchName, config.allowed_branches)) {
      return {
        allowed: false,
        message: `Branch '${branchName}' is not in allowed list. Allowed patterns: ${config.allowed_branches.join(", ")}`,
      };
    }
  } else if (config.blocked_branches) {
    if (branchMatchesPattern(branchName, config.blocked_branches)) {
      return {
        allowed: false,
        message: `Branch '${branchName}' is blocked. Blocked patterns: ${config.blocked_branches.join(", ")}`,
      };
    }
  }

  return { allowed: true, message: "Branch allowed" };
}

// ============================================================================
// Force Push Detection
// ============================================================================

const ZERO_SHA = "0000000000000000000000000000000000000000";

async function validateForcePush(
  update: RefUpdate,
  config: RepoConfig,
  repoPath: string,
): Promise<ValidationResult> {
  // New branch creation is always allowed
  if (update.oldSha === ZERO_SHA) {
    return { allowed: true, message: "New branch creation" };
  }

  // Branch deletion
  if (update.newSha === ZERO_SHA) {
    if (config.force_push === "deny") {
      return {
        allowed: false,
        message: "Branch deletion is not allowed (force_push: deny)",
      };
    }
    return { allowed: true, message: "Branch deletion allowed" };
  }

  // Check if this is a force push (old sha is not ancestor of new sha)
  const result = await git(
    ["merge-base", "--is-ancestor", update.oldSha, update.newSha],
    { cwd: repoPath },
  );

  if (!result.success) {
    // Not an ancestor = force push
    if (config.force_push === "deny") {
      return {
        allowed: false,
        message: `Force push detected and not allowed. Old: ${update.oldSha.slice(0, 8)}, New: ${update.newSha.slice(0, 8)}`,
      };
    }
    log.warn(`Force push allowed on ${update.refName}`);
    return { allowed: true, message: "Force push allowed", isForcePush: true };
  }

  return { allowed: true, message: "Push is fast-forward", isForcePush: false };
}

// ============================================================================
// Protected Path Validation
// ============================================================================

async function validateProtectedPaths(
  update: RefUpdate,
  config: RepoConfig,
  repoPath: string,
): Promise<ValidationResult> {
  if (config.protected_paths.length === 0) {
    return { allowed: true, message: "No protected paths configured" };
  }

  // Skip for branch deletion
  if (update.newSha === ZERO_SHA) {
    return { allowed: true, message: "Branch deletion - no path check needed" };
  }

  // Get changed files compared to base branch
  const baseBranch = `origin/${config.base_branch}`;

  // First check if base branch exists
  const baseCheck = await git(["rev-parse", "--verify", baseBranch], {
    cwd: repoPath,
  });

  if (!baseCheck.success) {
    return {
      allowed: false,
      message: `Base branch ${baseBranch} not found. Cannot validate protected paths.`,
    };
  }

  // Get the list of new commits being pushed (commits reachable from newSha but not from baseBranch)
  // This works even in quarantine because we're finding commits, not merge-bases
  const newCommitsResult = await git(
    ["rev-list", update.newSha, "--not", baseBranch],
    { cwd: repoPath },
  );

  if (!newCommitsResult.success) {
    return {
      allowed: false,
      message: `Failed to get new commits: ${newCommitsResult.stderr}`,
    };
  }

  const newCommits = newCommitsResult.stdout
    .trim()
    .split("\n")
    .filter((c) => c.length > 0);
  log.debug(`New commits being pushed: ${newCommits.length}`);

  if (newCommits.length === 0) {
    // No new commits relative to base branch - nothing to check
    // This can happen when:
    // 1. The pushed commit already exists in the base branch
    // 2. Fast-forwarding an existing branch to catch up with base
    // 3. Pushing the base branch itself
    return { allowed: true, message: "No new commits to check" };
  }

  // Get the net diff between base branch and the new commit
  // This correctly handles reverts - only files with actual changes in the final state are detected
  const diffResult = await git(
    ["diff", "--name-only", baseBranch, update.newSha],
    { cwd: repoPath },
  );

  if (!diffResult.success) {
    return {
      allowed: false,
      message: `Failed to get diff: ${diffResult.stderr}`,
    };
  }

  log.debug(`Files changed in push: ${diffResult.stdout.trim().split("\n").join(", ")}`);

  return checkChangedFiles(diffResult.stdout, config.protected_paths);
}

function checkChangedFiles(
  diffOutput: string,
  protectedPaths: readonly string[],
): ValidationResult {
  const changedFiles = diffOutput
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);

  const violations = changedFiles.filter((file) =>
    matchesAnyPattern(file, protectedPaths),
  );

  if (violations.length > 0) {
    return {
      allowed: false,
      message: `Changes to protected paths detected:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
    };
  }

  return { allowed: true, message: "No protected path violations" };
}

// ============================================================================
// Upstream Divergence Check
// ============================================================================

// TODO: This check is likely redundant. The upstream remote will reject
// non-fast-forward pushes anyway. The only upside is that since this proxy
// runs close to the VM, it gives early rejection (saves a few ms vs waiting
// for remote to reject). Consider removing this function entirely.
async function checkUpstreamDivergence(
  update: RefUpdate,
  repoPath: string,
): Promise<ValidationResult> {
  // Skip for new branches
  if (update.oldSha === ZERO_SHA) {
    return { allowed: true, message: "New branch - no divergence check" };
  }

  // Check if our local ref matches what's on origin
  const remoteRef = update.refName.replace(
    "refs/heads/",
    "refs/remotes/origin/",
  );

  const result = await git(["rev-parse", "--verify", remoteRef], {
    cwd: repoPath,
  });

  if (!result.success) {
    // Remote branch doesn't exist yet - OK
    return { allowed: true, message: "Remote branch doesn't exist yet" };
  }

  const remoteSha = result.stdout.trim();

  if (remoteSha !== update.oldSha) {
    return {
      allowed: false,
      message: `Upstream has diverged. Expected: ${update.oldSha.slice(0, 8)}, Actual: ${remoteSha.slice(0, 8)}. Please fetch and rebase.`,
    };
  }

  return { allowed: true, message: "Upstream in sync" };
}

// ============================================================================
// Push to Upstream
// ============================================================================

async function pushToUpstream(
  update: RefUpdate,
  repoPath: string,
  sshEnv: Record<string, string>,
  forcePush: boolean = false,
): Promise<ValidationResult> {
  const branchName = update.refName.replace(/^refs\/heads\//, "");

  let args: string[];
  if (update.newSha === ZERO_SHA) {
    // Branch deletion
    args = ["push", "origin", "--delete", branchName];
  } else if (forcePush) {
    // Force push - need --force flag
    args = [
      "push",
      "--force",
      "origin",
      `${update.newSha}:refs/heads/${branchName}`,
    ];
  } else {
    // Normal push
    args = ["push", "origin", `${update.newSha}:refs/heads/${branchName}`];
  }

  log.info(`Pushing to upstream: git ${args.join(" ")}`);

  // We need to unset GIT_QUARANTINE_PATH to allow pushing from within pre-receive hook
  // Create a clean copy of process.env without quarantine variables, then add sshEnv
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Skip quarantine-related variables that prevent pushing from pre-receive
    if (key === "GIT_QUARANTINE_PATH") continue;
    if (value !== undefined) {
      cleanEnv[key] = value;
    }
  }
  // Add SSH configuration
  Object.assign(cleanEnv, sshEnv);

  const result = await git(args, {
    cwd: repoPath,
    env: cleanEnv,
    fullEnv: true, // Use this env exactly, don't merge with process.env
  });

  if (!result.success) {
    return {
      allowed: false,
      message: `Failed to push to upstream:\n${result.stderr}`,
    };
  }

  return { allowed: true, message: "Successfully pushed to upstream" };
}

// ============================================================================
// Main Validation Entry Point
// ============================================================================

export interface PreReceiveContext {
  repoPath: string;
  repoConfig: RepoConfig;
  sshEnv: Record<string, string>;
}

export async function validateAndPush(
  updates: readonly RefUpdate[],
  ctx: PreReceiveContext,
): Promise<ValidationResult> {
  const errors: string[] = [];

  // First pass: validate all updates before pushing anything
  const validatedUpdates: Array<{ update: RefUpdate; isForcePush: boolean }> = [];

  for (const update of updates) {
    log.info(
      `Validating: ${update.refName} ${update.oldSha.slice(0, 8)}..${update.newSha.slice(0, 8)}`,
    );

    // 1. Validate branch name
    const branchResult = validateBranch(update.refName, ctx.repoConfig);
    if (!branchResult.allowed) {
      errors.push(branchResult.message);
      continue;
    }

    // 2. Check for force push
    const forcePushResult = await validateForcePush(
      update,
      ctx.repoConfig,
      ctx.repoPath,
    );
    if (!forcePushResult.allowed) {
      errors.push(forcePushResult.message);
      continue;
    }
    const isForcePush = forcePushResult.isForcePush ?? false;

    // 3. Check upstream divergence (skip for force push - we expect divergence)
    if (!isForcePush) {
      const divergenceResult = await checkUpstreamDivergence(
        update,
        ctx.repoPath,
      );
      if (!divergenceResult.allowed) {
        errors.push(divergenceResult.message);
        continue;
      }
    }

    // 4. Check protected paths
    const pathResult = await validateProtectedPaths(
      update,
      ctx.repoConfig,
      ctx.repoPath,
    );
    if (!pathResult.allowed) {
      errors.push(pathResult.message);
      continue;
    }

    validatedUpdates.push({ update, isForcePush });
  }

  // If any validation failed, reject everything
  if (errors.length > 0) {
    return {
      allowed: false,
      message: formatRejectionMessage(errors),
    };
  }

  // Second pass: push all validated updates to upstream
  for (const { update, isForcePush } of validatedUpdates) {
    const pushResult = await pushToUpstream(
      update,
      ctx.repoPath,
      ctx.sshEnv,
      isForcePush,
    );
    if (!pushResult.allowed) {
      return {
        allowed: false,
        message: formatRejectionMessage([pushResult.message]),
      };
    }

    log.info(`Successfully validated and pushed ${update.refName}`);
  }

  return {
    allowed: true,
    message: "All refs validated and pushed successfully",
  };
}

function formatRejectionMessage(errors: readonly string[]): string {
  const separator = "=".repeat(50);
  return [
    "",
    separator,
    "PUSH REJECTED",
    separator,
    ...errors,
    separator,
    "",
  ].join("\n");
}

// ============================================================================
// Parse pre-receive stdin
// ============================================================================

export function parsePreReceiveInput(input: string): RefUpdate[] {
  return input
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(" ");
      const oldSha = parts[0];
      const newSha = parts[1];
      const refName = parts[2];

      if (!oldSha || !newSha || !refName) {
        throw new Error(`Invalid pre-receive input line: ${line}`);
      }

      return { oldSha, newSha, refName };
    });
}
