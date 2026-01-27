import { log } from "./utils.ts";

// ============================================================================
// CGI Environment Setup for git-http-backend
// ============================================================================

interface GitBackendRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  repoPath: string;
  repoName: string;
}

function buildCgiEnv(req: GitBackendRequest): Record<string, string> {
  const env: Record<string, string> = {
    // CGI 1.1 required variables
    REQUEST_METHOD: req.method,
    QUERY_STRING: req.url.search.slice(1), // Remove leading ?
    CONTENT_TYPE: req.headers.get("content-type") ?? "",
    CONTENT_LENGTH: req.headers.get("content-length") ?? "",
    PATH_INFO: req.url.pathname.replace(`/${req.repoName}.git`, ""),
    PATH_TRANSLATED: req.repoPath + req.url.pathname.replace(`/${req.repoName}.git`, ""),
    SCRIPT_NAME: `/${req.repoName}.git`,
    SERVER_NAME: req.url.hostname,
    SERVER_PORT: req.url.port || "80",
    SERVER_PROTOCOL: "HTTP/1.1",
    SERVER_SOFTWARE: "git-proxy/0.1",
    GATEWAY_INTERFACE: "CGI/1.1",

    // git-http-backend specific
    GIT_PROJECT_ROOT: req.repoPath,
    GIT_HTTP_EXPORT_ALL: "1",

    // Enable receive-pack (push)
    GIT_HTTP_RECEIVE_PACK: "true",
    // Enable upload-pack (fetch/clone)
    GIT_HTTP_UPLOAD_PACK: "true",
  };

  // Add HTTP headers as HTTP_* environment variables
  req.headers.forEach((value, key) => {
    const envKey = "HTTP_" + key.toUpperCase().replace(/-/g, "_");
    env[envKey] = value;
  });

  return env;
}

// ============================================================================
// Parse CGI Response
// ============================================================================

interface CgiResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
}

function parseCgiResponse(output: Uint8Array): CgiResponse {
  // Find the header/body separator (double CRLF or double LF)
  let separatorIndex = -1;
  let separatorLength = 0;

  for (let i = 0; i < output.length - 1; i++) {
    // Check for \r\n\r\n
    if (
      output[i] === 0x0d &&
      output[i + 1] === 0x0a &&
      output[i + 2] === 0x0d &&
      output[i + 3] === 0x0a
    ) {
      separatorIndex = i;
      separatorLength = 4;
      break;
    }
    // Check for \n\n
    if (output[i] === 0x0a && output[i + 1] === 0x0a) {
      separatorIndex = i;
      separatorLength = 2;
      break;
    }
  }

  if (separatorIndex === -1) {
    // No body, all headers
    separatorIndex = output.length;
    separatorLength = 0;
  }

  const headerBytes = output.slice(0, separatorIndex);
  const bodyBytes = output.slice(separatorIndex + separatorLength);

  const headerText = new TextDecoder().decode(headerBytes);
  const headerLines = headerText.split(/\r?\n/);

  const headers = new Headers();
  let status = 200;
  let statusText = "OK";

  for (const line of headerLines) {
    if (line.length === 0) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const name = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (name === "status") {
      // CGI Status header: "Status: 404 Not Found"
      const parts = value.split(" ");
      const statusCode = parts[0];
      if (statusCode) {
        status = parseInt(statusCode, 10);
      }
      statusText = parts.slice(1).join(" ") || "OK";
    } else {
      headers.set(name, value);
    }
  }

  return {
    status,
    statusText,
    headers,
    body: bodyBytes,
  };
}

// ============================================================================
// Execute git-http-backend
// ============================================================================

export async function executeGitHttpBackend(
  req: GitBackendRequest
): Promise<Response> {
  const env = buildCgiEnv(req);

  log.debug("CGI Environment:", env);

  // Find git-http-backend
  const gitHttpBackend = await findGitHttpBackend();

  // Stream request body directly to the process stdin
  const proc = Bun.spawn([gitHttpBackend], {
    env: { ...process.env, ...env },
    cwd: req.repoPath,
    stdin: req.body ?? undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Collect output
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stderr) {
    log.debug("git-http-backend stderr:", stderr);
  }

  if (exitCode !== 0) {
    log.error(`git-http-backend exited with code ${exitCode}`);
    log.error("stderr:", stderr);
  }

  // Parse CGI response
  const cgiResponse = parseCgiResponse(stdout);

  return new Response(cgiResponse.body, {
    status: cgiResponse.status,
    statusText: cgiResponse.statusText,
    headers: cgiResponse.headers,
  });
}

// ============================================================================
// Find git-http-backend executable
// ============================================================================

let cachedGitHttpBackendPath: string | undefined;

async function findGitHttpBackend(): Promise<string> {
  if (cachedGitHttpBackendPath) {
    return cachedGitHttpBackendPath;
  }

  // Common locations for git-http-backend
  const candidates = [
    "/usr/lib/git-core/git-http-backend",
    "/usr/libexec/git-core/git-http-backend",
    "/usr/local/libexec/git-core/git-http-backend",
    "/opt/homebrew/opt/git/libexec/git-core/git-http-backend",
  ];

  // Also try to find via git --exec-path
  const proc = Bun.spawn(["git", "--exec-path"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const execPath = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  if (execPath) {
    candidates.unshift(`${execPath}/git-http-backend`);
  }

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      cachedGitHttpBackendPath = candidate;
      log.info(`Found git-http-backend at: ${candidate}`);
      return candidate;
    }
  }

  throw new Error(
    "Could not find git-http-backend. Searched:\n" + candidates.join("\n")
  );
}

// ============================================================================
// Export request builder
// ============================================================================

export function createGitBackendRequest(
  request: Request,
  repoPath: string,
  repoName: string
): GitBackendRequest {
  return {
    method: request.method,
    url: new URL(request.url),
    headers: request.headers,
    body: request.body,
    repoPath,
    repoName,
  };
}
