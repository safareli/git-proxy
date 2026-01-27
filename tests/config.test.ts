import { describe, test, expect } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config", () => {
  const createTempConfig = (content: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "git-proxy-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  };

  test("loads valid config with allowed_branches", () => {
    const configPath = createTempConfig({
      repos: {
        test: {
          upstream: "git@github.com:user/test.git",
          allowed_branches: ["agent/*"],
        },
      },
    });

    const config = loadConfig(configPath);
    expect(config.repos["test"]?.upstream).toBe("git@github.com:user/test.git");
    expect(config.repos["test"]?.allowed_branches).toEqual(["agent/*"]);
    expect(config.repos["test"]?.force_push).toBe("deny"); // default
    expect(config.repos["test"]?.base_branch).toBe("main"); // default
  });

  test("loads valid config with blocked_branches", () => {
    const configPath = createTempConfig({
      repos: {
        test: {
          upstream: "git@github.com:user/test.git",
          blocked_branches: ["main", "master"],
        },
      },
    });

    const config = loadConfig(configPath);
    expect(config.repos["test"]?.blocked_branches).toEqual(["main", "master"]);
  });

  test("rejects config with both allowed and blocked branches", () => {
    const configPath = createTempConfig({
      repos: {
        test: {
          upstream: "git@github.com:user/test.git",
          allowed_branches: ["agent/*"],
          blocked_branches: ["main"],
        },
      },
    });

    expect(() => loadConfig(configPath)).toThrow(
      "Cannot specify both allowed_branches and blocked_branches"
    );
  });

  test("rejects config without any branch policy", () => {
    const configPath = createTempConfig({
      repos: {
        test: {
          upstream: "git@github.com:user/test.git",
        },
      },
    });

    expect(() => loadConfig(configPath)).toThrow(
      "Must specify either allowed_branches or blocked_branches"
    );
  });

  test("rejects config with empty upstream", () => {
    const configPath = createTempConfig({
      repos: {
        test: {
          upstream: "",
          allowed_branches: ["agent/*"],
        },
      },
    });

    expect(() => loadConfig(configPath)).toThrow("upstream URL is required");
  });

  test("throws on missing config file", () => {
    expect(() => loadConfig("/nonexistent/path/config.json")).toThrow(
      "Config file not found"
    );
  });

  test("throws on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-proxy-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ invalid json }");

    expect(() => loadConfig(path)).toThrow("Invalid JSON");
  });
});
