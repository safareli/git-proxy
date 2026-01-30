import { describe, test, expect } from "bun:test";
import { parseRepoFromPath } from "../src/server.ts";

describe("parseRepoFromPath", () => {
  describe("valid paths", () => {
    test("parses simple repo path without subpath", () => {
      const result = parseRepoFromPath("/myrepo.git");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "",
      });
    });

    test("parses repo path with subpath", () => {
      const result = parseRepoFromPath("/myrepo.git/info/refs");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "/info/refs",
      });
    });

    test("parses repo path with git-upload-pack", () => {
      const result = parseRepoFromPath("/myrepo.git/git-upload-pack");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "/git-upload-pack",
      });
    });

    test("parses repo path with git-receive-pack", () => {
      const result = parseRepoFromPath("/myrepo.git/git-receive-pack");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "/git-receive-pack",
      });
    });

    test("parses repo with dashes in name", () => {
      const result = parseRepoFromPath("/my-awesome-repo.git");
      expect(result).toEqual({
        repoName: "my-awesome-repo",
        subPath: "",
      });
    });

    test("parses repo with underscores in name", () => {
      const result = parseRepoFromPath("/my_repo_name.git");
      expect(result).toEqual({
        repoName: "my_repo_name",
        subPath: "",
      });
    });

    test("parses repo with numbers in name", () => {
      const result = parseRepoFromPath("/repo123.git");
      expect(result).toEqual({
        repoName: "repo123",
        subPath: "",
      });
    });

    test("parses repo with dots in name", () => {
      const result = parseRepoFromPath("/my.repo.name.git");
      expect(result).toEqual({
        repoName: "my.repo.name",
        subPath: "",
      });
    });

    test("parses repo with nested subpath", () => {
      const result = parseRepoFromPath("/myrepo.git/objects/info/packs");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "/objects/info/packs",
      });
    });

    test("parses repo with query-string-like subpath", () => {
      const result = parseRepoFromPath("/myrepo.git/info/refs?service=git-upload-pack");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "/info/refs?service=git-upload-pack",
      });
    });

    test("parses repo with trailing slash in subpath", () => {
      const result = parseRepoFromPath("/myrepo.git/info/");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "/info/",
      });
    });
  });

  describe("invalid paths", () => {
    test("returns null for path without .git extension", () => {
      const result = parseRepoFromPath("/myrepo");
      expect(result).toBeNull();
    });

    test("returns null for path without leading slash", () => {
      const result = parseRepoFromPath("myrepo.git");
      expect(result).toBeNull();
    });

    test("returns null for empty path", () => {
      const result = parseRepoFromPath("");
      expect(result).toBeNull();
    });

    test("returns null for root path", () => {
      const result = parseRepoFromPath("/");
      expect(result).toBeNull();
    });

    test("parses path with nested directories (namespaced repo)", () => {
      const result = parseRepoFromPath("/path/to/myrepo.git");
      expect(result).toEqual({
        repoName: "path/to/myrepo",
        subPath: "",
      });
    });

    test("returns null for .git without repo name", () => {
      const result = parseRepoFromPath("/.git");
      expect(result).toBeNull();
    });

    test("returns null for path with .git in middle", () => {
      const result = parseRepoFromPath("/myrepo.git.backup");
      expect(result).toBeNull();
    });

    test("returns null for path with only slash and .git", () => {
      const result = parseRepoFromPath("/.git/info/refs");
      expect(result).toBeNull();
    });

    test("returns null for non-git path", () => {
      const result = parseRepoFromPath("/health");
      expect(result).toBeNull();
    });

    test("returns null for health check path", () => {
      const result = parseRepoFromPath("/healthz");
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("parses path with multiple .git segments (treats second as subpath)", () => {
      const result = parseRepoFromPath("/repo1.git/repo2.git");
      expect(result).toEqual({
        repoName: "repo1",
        subPath: "/repo2.git",
      });
    });

    test("parses repo name with spaces", () => {
      const result = parseRepoFromPath("/my repo.git");
      expect(result).toEqual({
        repoName: "my repo",
        subPath: "",
      });
    });

    test("handles very long repo names", () => {
      const longName = "a".repeat(200);
      const result = parseRepoFromPath(`/${longName}.git`);
      expect(result).toEqual({
        repoName: longName,
        subPath: "",
      });
    });

    test("handles very long subpaths", () => {
      const longPath = "/a".repeat(100);
      const result = parseRepoFromPath(`/myrepo.git${longPath}`);
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: longPath,
      });
    });

    test("handles special characters in repo name", () => {
      const result = parseRepoFromPath("/repo-name_123.test.git");
      expect(result).toEqual({
        repoName: "repo-name_123.test",
        subPath: "",
      });
    });

    test("parses namespaced repo with subpath", () => {
      const result = parseRepoFromPath("/user/project.git/info/refs");
      expect(result).toEqual({
        repoName: "user/project",
        subPath: "/info/refs",
      });
    });

    test("parses deeply namespaced repo", () => {
      const result = parseRepoFromPath("/org/team/project.git/git-receive-pack");
      expect(result).toEqual({
        repoName: "org/team/project",
        subPath: "/git-receive-pack",
      });
    });

    test("handles URL-encoded characters in subpath", () => {
      const result = parseRepoFromPath("/myrepo.git/info/refs%20test");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "/info/refs%20test",
      });
    });

    test("handles multiple slashes in subpath", () => {
      const result = parseRepoFromPath("/myrepo.git//info//refs");
      expect(result).toEqual({
        repoName: "myrepo",
        subPath: "//info//refs",
      });
    });
  });

  describe("real-world git paths", () => {
    test("parses git fetch info/refs", () => {
      const result = parseRepoFromPath("/project.git/info/refs");
      expect(result).toEqual({
        repoName: "project",
        subPath: "/info/refs",
      });
    });

    test("parses git clone upload-pack", () => {
      const result = parseRepoFromPath("/project.git/git-upload-pack");
      expect(result).toEqual({
        repoName: "project",
        subPath: "/git-upload-pack",
      });
    });

    test("parses git push receive-pack", () => {
      const result = parseRepoFromPath("/project.git/git-receive-pack");
      expect(result).toEqual({
        repoName: "project",
        subPath: "/git-receive-pack",
      });
    });

    test("parses object access path", () => {
      const result = parseRepoFromPath("/project.git/objects/12/3456789abcdef");
      expect(result).toEqual({
        repoName: "project",
        subPath: "/objects/12/3456789abcdef",
      });
    });

    test("parses HEAD ref path", () => {
      const result = parseRepoFromPath("/project.git/HEAD");
      expect(result).toEqual({
        repoName: "project",
        subPath: "/HEAD",
      });
    });
  });
});
