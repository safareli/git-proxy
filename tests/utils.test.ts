import { describe, test, expect } from "bun:test";
import {
  matchesAnyPattern,
  branchMatchesPattern,
  withLock,
  sleep,
} from "../src/utils.ts";

describe("glob matching", () => {
  describe("matchesAnyPattern", () => {
    const patterns = [".github/**", "*.nix", "nix/", "Makefile"];

    test("matches .github paths", () => {
      expect(matchesAnyPattern(".github/workflows/ci.yml", patterns)).toBe(true);
      expect(matchesAnyPattern(".github/CODEOWNERS", patterns)).toBe(true);
    });

    test("matches nix files", () => {
      expect(matchesAnyPattern("flake.nix", patterns)).toBe(true);
      expect(matchesAnyPattern("nix/flake.nix", patterns)).toBe(true);
    });

    test("matches nix directory", () => {
      expect(matchesAnyPattern("nix/default.nix", patterns)).toBe(true);
    });

    test("matches Makefile", () => {
      expect(matchesAnyPattern("Makefile", patterns)).toBe(true);
    });

    test("does not match other files", () => {
      expect(matchesAnyPattern("src/main.ts", patterns)).toBe(false);
      expect(matchesAnyPattern("README.md", patterns)).toBe(false);
      expect(matchesAnyPattern("package.json", patterns)).toBe(false);
    });
  });

  describe("branchMatchesPattern", () => {
    test("matches with refs/heads/ prefix", () => {
      expect(branchMatchesPattern("refs/heads/agent/test", ["agent/*"])).toBe(true);
      expect(branchMatchesPattern("refs/heads/main", ["main"])).toBe(true);
    });

    test("matches without prefix", () => {
      expect(branchMatchesPattern("agent/test", ["agent/*"])).toBe(true);
      expect(branchMatchesPattern("feature/new", ["feature/*"])).toBe(true);
    });

    test("does not match non-matching branches", () => {
      expect(branchMatchesPattern("main", ["agent/*"])).toBe(false);
      expect(branchMatchesPattern("refs/heads/main", ["agent/*"])).toBe(false);
    });

    test("matches multiple patterns", () => {
      const patterns = ["agent/*", "ai/*", "feature/*"];
      expect(branchMatchesPattern("agent/foo", patterns)).toBe(true);
      expect(branchMatchesPattern("ai/bar", patterns)).toBe(true);
      expect(branchMatchesPattern("feature/baz", patterns)).toBe(true);
      expect(branchMatchesPattern("main", patterns)).toBe(false);
    });
  });
});

describe("withLock", () => {
  test("executes function and returns result", async () => {
    const result = await withLock("test-repo", async () => {
      return "test-result";
    });
    expect(result).toBe("test-result");
  });

  test("executes async function and returns result", async () => {
    const result = await withLock("test-repo", async () => {
      await sleep(10);
      return 42;
    });
    expect(result).toBe(42);
  });

  test("propagates errors from function", async () => {
    await expect(
      withLock("test-repo", async () => {
        throw new Error("test error");
      }),
    ).rejects.toThrow("test error");
  });

  test("ensures sequential execution for same repo", async () => {
    const executionOrder: number[] = [];
    const repoName = "sequential-repo";

    const task1 = withLock(repoName, async () => {
      executionOrder.push(1);
      await sleep(50);
      executionOrder.push(2);
    });

    const task2 = withLock(repoName, async () => {
      executionOrder.push(3);
      await sleep(20);
      executionOrder.push(4);
    });

    await Promise.all([task1, task2]);

    // Task 2 should not start until task 1 completes
    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  test("allows parallel execution for different repos", async () => {
    const executionOrder: string[] = [];
    const startTime = Date.now();

    const task1 = withLock("repo1", async () => {
      executionOrder.push("repo1-start");
      await sleep(50);
      executionOrder.push("repo1-end");
    });

    const task2 = withLock("repo2", async () => {
      executionOrder.push("repo2-start");
      await sleep(50);
      executionOrder.push("repo2-end");
    });

    await Promise.all([task1, task2]);
    const duration = Date.now() - startTime;

    // Both should start before either finishes (parallel execution)
    expect(executionOrder).toContain("repo1-start");
    expect(executionOrder).toContain("repo2-start");
    
    // Duration should be ~50ms (parallel), not ~100ms (sequential)
    // Allow some margin for test execution overhead
    expect(duration).toBeLessThan(100);
  });

  test("handles multiple sequential operations on same repo", async () => {
    const results: number[] = [];
    const repoName = "multi-op-repo";

    const operations = [1, 2, 3, 4, 5].map((num) =>
      withLock(repoName, async () => {
        await sleep(10);
        results.push(num);
        return num;
      }),
    );

    const values = await Promise.all(operations);

    // All operations should complete
    expect(values).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  test("releases lock even when function throws", async () => {
    const repoName = "error-repo";
    const executionOrder: string[] = [];

    // First operation throws
    const task1 = withLock(repoName, async () => {
      executionOrder.push("task1");
      throw new Error("task1 error");
    }).catch((e) => e.message);

    // Second operation should still execute after first fails
    const task2 = withLock(repoName, async () => {
      executionOrder.push("task2");
      return "success";
    });

    const [result1, result2] = await Promise.all([task1, task2]);

    expect(result1).toBe("task1 error");
    expect(result2).toBe("success");
    expect(executionOrder).toEqual(["task1", "task2"]);
  });

  test("handles concurrent locks on multiple repos", async () => {
    const results: string[] = [];
    
    const tasks = [
      withLock("repo-a", async () => {
        await sleep(30);
        results.push("a1");
      }),
      withLock("repo-b", async () => {
        await sleep(20);
        results.push("b1");
      }),
      withLock("repo-a", async () => {
        await sleep(10);
        results.push("a2");
      }),
      withLock("repo-b", async () => {
        await sleep(10);
        results.push("b2");
      }),
    ];

    await Promise.all(tasks);

    // Within each repo, operations should be sequential
    const aIndex1 = results.indexOf("a1");
    const aIndex2 = results.indexOf("a2");
    const bIndex1 = results.indexOf("b1");
    const bIndex2 = results.indexOf("b2");

    expect(aIndex1).toBeLessThan(aIndex2);
    expect(bIndex1).toBeLessThan(bIndex2);
    
    // All operations should complete
    expect(results.sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  test("returns correct value types", async () => {
    const stringResult = await withLock("repo1", async () => "string");
    expect(typeof stringResult).toBe("string");

    const numberResult = await withLock("repo2", async () => 123);
    expect(typeof numberResult).toBe("number");

    const objectResult = await withLock("repo3", async () => ({ key: "value" }));
    expect(objectResult).toEqual({ key: "value" });

    const arrayResult = await withLock("repo4", async () => [1, 2, 3]);
    expect(arrayResult).toEqual([1, 2, 3]);
  });
});
