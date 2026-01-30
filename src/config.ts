import { z } from "zod";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";

// ============================================================================
// Zod Schemas
// ============================================================================

const RepoConfigSchema = z
  .object({
    upstream: z.string().min(1, "upstream URL is required"),

    protected_paths: z.array(z.string()).default([]),

    allowed_branches: z.array(z.string()).optional(),
    blocked_branches: z.array(z.string()).optional(),

    force_push: z.enum(["deny", "allow"]).default("deny"),

    base_branch: z.string().default("main"),
  })
  .refine(
    (data) => !(data.allowed_branches && data.blocked_branches),
    "Cannot specify both allowed_branches and blocked_branches",
  )
  .refine(
    (data) => data.allowed_branches ?? data.blocked_branches,
    "Must specify either allowed_branches or blocked_branches",
  );

const ConfigSchema = z.object({
  ssh_key_path: z.string().optional(),
  repos: z.record(z.string(), RepoConfigSchema),
});

// ============================================================================
// Types (derived from Zod schemas)
// ============================================================================

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// ============================================================================
// Config Loading
// ============================================================================

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`);
  }

  const result = ConfigSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${errors}`);
  }

  return result.data;
}

// ============================================================================
// Environment & CLI Config
// ============================================================================

export interface RuntimeConfig {
  configPath: string;
  reposDir: string;
  httpPort: number;
  logLevel: "debug" | "info" | "warn" | "error";
  sshKeyPath: string | undefined;
}

export function getRuntimeConfig(): RuntimeConfig {
  const configPath = resolve(
    process.env["GIT_PROXY_CONFIG"] ?? "/etc/git-proxy/config.json",
  );
  const reposDir = resolve(
    process.env["REPOS_DIR"] ?? "/var/lib/git-proxy/repos",
  );
  const httpPort = parseInt(process.env["HTTP_PORT"] ?? "8080", 10);
  const logLevel = (process.env["LOG_LEVEL"] ??
    "info") as RuntimeConfig["logLevel"];
  const sshKeyPath = process.env["GIT_SSH_KEY_PATH"];

  if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`Invalid HTTP_PORT: ${process.env["HTTP_PORT"]}`);
  }

  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: ${logLevel}`);
  }

  return { configPath, reposDir, httpPort, logLevel, sshKeyPath };
}
