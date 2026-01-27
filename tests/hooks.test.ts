import { describe, test, expect } from "bun:test";
import type { RepoConfig } from "../src/config.ts";
import { validateBranch } from "../src/hooks.ts";

describe("validateBranch", () => {
  const baseConfig: Omit<RepoConfig, "allowed_branches" | "blocked_branches"> = {
    upstream: "git@github.com:org/repo.git",
    protected_paths: [],
    force_push: "deny",
    base_branch: "main",
  };

  describe("ref name validation", () => {
    test("allows valid branch refs", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["*"],
      };

      const result = validateBranch("refs/heads/main", config);
      expect(result.allowed).toBe(true);
      expect(result.message).toBe("Branch allowed");
    });

    test("rejects tag refs", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["*"],
      };

      const result = validateBranch("refs/tags/v1.0.0", config);
      expect(result.allowed).toBe(false);
      expect(result.message).toContain("Only branch pushes allowed");
      expect(result.message).toContain("refs/tags/v1.0.0");
    });

    test("rejects other refs", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["*"],
      };

      const result = validateBranch("refs/pull/123", config);
      expect(result.allowed).toBe(false);
      expect(result.message).toContain("Only branch pushes allowed");
    });

    test("rejects bare branch names without refs/heads/", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["*"],
      };

      const result = validateBranch("main", config);
      expect(result.allowed).toBe(false);
      expect(result.message).toContain("Only branch pushes allowed");
    });
  });

  describe("allowed_branches config", () => {
    test("allows branches matching allowed patterns", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["main", "develop", "feature/*"],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/develop", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/new-feature", config).allowed).toBe(true);
      // Note: feature/* only matches one level, not nested paths
      expect(validateBranch("refs/heads/feature/user/test", config).allowed).toBe(false);
    });

    test("rejects branches not matching allowed patterns", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["main", "develop"],
      };

      const result = validateBranch("refs/heads/feature/test", config);
      expect(result.allowed).toBe(false);
      expect(result.message).toContain("not in allowed list");
      expect(result.message).toContain("feature/test");
      expect(result.message).toContain("main, develop");
    });

    test("handles wildcard pattern '*' to allow all branches", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["*"],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/any-branch", config).allowed).toBe(true);
      // Note: * doesn't match slashes, need ** or */** for nested paths
      expect(validateBranch("refs/heads/feature/test", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/hotfix/bug-123", config).allowed).toBe(false);
    });

    test("handles multiple wildcard patterns", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["feature/**", "bugfix/**", "hotfix/**"],
      };

      expect(validateBranch("refs/heads/feature/new", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/bugfix/issue-123", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/hotfix/critical", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/main", config).allowed).toBe(false);
    });

    test("handles nested wildcards", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["user/**"],
      };

      expect(validateBranch("refs/heads/user/john/feature", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/user/jane/bugfix", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/user/john", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/admin/john", config).allowed).toBe(false);
    });

    test("handles exact matches combined with wildcards", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["main", "develop", "feature/**"],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/develop", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/xyz", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/user/test", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/staging", config).allowed).toBe(false);
    });
  });

  describe("blocked_branches config", () => {
    test("blocks branches matching blocked patterns", () => {
      const config: RepoConfig = {
        ...baseConfig,
        blocked_branches: ["main", "production"],
      };

      const result1 = validateBranch("refs/heads/main", config);
      expect(result1.allowed).toBe(false);
      expect(result1.message).toContain("blocked");
      expect(result1.message).toContain("main");

      const result2 = validateBranch("refs/heads/production", config);
      expect(result2.allowed).toBe(false);
      expect(result2.message).toContain("blocked");
    });

    test("allows branches not matching blocked patterns", () => {
      const config: RepoConfig = {
        ...baseConfig,
        blocked_branches: ["main", "production"],
      };

      expect(validateBranch("refs/heads/develop", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/test", config).allowed).toBe(true);
    });

    test("blocks wildcard patterns", () => {
      const config: RepoConfig = {
        ...baseConfig,
        blocked_branches: ["release/**", "hotfix/**"],
      };

      expect(validateBranch("refs/heads/release/v1.0", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/hotfix/bug", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/feature/new", config).allowed).toBe(true);
    });

    test("allows all except blocked with '*' in allowed context", () => {
      const config: RepoConfig = {
        ...baseConfig,
        blocked_branches: ["main"],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/develop", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/anything", config).allowed).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("handles empty branch name after refs/heads/", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["**"],
      };

      const result = validateBranch("refs/heads/", config);
      // Empty branch name should be allowed by the pattern matcher
      // but might fail at other validation stages
      expect(result.allowed).toBe(true);
    });

    test("handles branch names with special characters", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["**"],
      };

      expect(validateBranch("refs/heads/feature/test-123", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/user_name/branch", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/fix.issue", config).allowed).toBe(true);
    });

    test("handles branch names with slashes", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["feature/**"],
      };

      expect(validateBranch("refs/heads/feature/user/test", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/a/b/c", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature", config).allowed).toBe(false);
    });

    test("case-sensitive matching", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["main"],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/Main", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/MAIN", config).allowed).toBe(false);
    });

    test("empty allowed_branches list blocks all branches", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: [],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/any", config).allowed).toBe(false);
    });

    test("empty blocked_branches list allows all branches", () => {
      const config: RepoConfig = {
        ...baseConfig,
        blocked_branches: [],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/any", config).allowed).toBe(true);
    });
  });

  describe("pattern matching specifics", () => {
    test("single wildcard matches one segment", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["feature/*"],
      };

      expect(validateBranch("refs/heads/feature/test", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/test-123", config).allowed).toBe(true);
      // * doesn't match nested paths
      expect(validateBranch("refs/heads/feature/user/test", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/feature", config).allowed).toBe(false);
    });

    test("double wildcard matches multiple segments", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["feature/**"],
      };

      expect(validateBranch("refs/heads/feature/test", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/user/test", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature/a/b/c", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/feature", config).allowed).toBe(false);
    });

    test("wildcard in middle", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["*/fix"],
      };

      expect(validateBranch("refs/heads/bug/fix", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/hotfix/fix", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/fix", config).allowed).toBe(false);
      // * doesn't match nested
      expect(validateBranch("refs/heads/user/bug/fix", config).allowed).toBe(false);
    });

    test("multiple single wildcards", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["*/*/test"],
      };

      expect(validateBranch("refs/heads/user/john/test", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/a/b/test", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/user/test", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/a/b/c/test", config).allowed).toBe(false);
    });
  });

  describe("real-world scenarios", () => {
    test("typical gitflow setup - block protected branches", () => {
      const config: RepoConfig = {
        ...baseConfig,
        blocked_branches: ["main", "develop"],
      };

      expect(validateBranch("refs/heads/main", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/develop", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/feature/new-feature", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/hotfix/bug-fix", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/release/1.0", config).allowed).toBe(true);
    });

    test("restrict to user namespace with any sub-branches", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["user/john/**"],
      };

      expect(validateBranch("refs/heads/user/john/feature", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/user/john/bugfix", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/user/john/feature/nested", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/user/jane/feature", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/main", config).allowed).toBe(false);
    });

    test("only allow prefixed branches (conventional commits style)", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["feat/**", "fix/**", "chore/**", "docs/**"],
      };

      expect(validateBranch("refs/heads/feat/new-ui", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/fix/bug-123", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/chore/cleanup", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/docs/update-readme", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/my-branch", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/main", config).allowed).toBe(false);
    });

    test("block temporary/personal branches", () => {
      const config: RepoConfig = {
        ...baseConfig,
        blocked_branches: ["tmp/**", "temp/**", "test/**", "wip/**"],
      };

      expect(validateBranch("refs/heads/tmp/experiment", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/temp/backup", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/test/something", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/wip/work", config).allowed).toBe(false);
      expect(validateBranch("refs/heads/feature/new", config).allowed).toBe(true);
    });

    test("allow everything except certain patterns", () => {
      const config: RepoConfig = {
        ...baseConfig,
        allowed_branches: ["**"],
      };

      expect(validateBranch("refs/heads/anything", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/deeply/nested/branch", config).allowed).toBe(true);
      expect(validateBranch("refs/heads/main", config).allowed).toBe(true);
    });
  });
});
