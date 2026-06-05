/**
 * Sandbox inspection surface (Decision 5 grading).
 *
 * The grader does not own a sandbox; it only inspects one that the agent run
 * has already finished mutating. The runner package provides the concrete
 * implementation backed by real infra (Firecracker microVM exec/cat/curl).
 * The grader depends only on this narrow interface so it can be tested with an
 * in-process fake.
 */

/** Result of executing a shell command inside the finished sandbox. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; 0 conventionally means success. */
  code: number;
}

/** Result of a single HTTP GET issued from within the sandbox network. */
export interface HttpResult {
  status: number;
  body: string;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Read-only-ish handle the grader uses to probe a finished sandbox.
 *
 * All methods reject only on infrastructure failures (sandbox gone, transport
 * error). Logical failures (non-zero exit, 404, missing file) are reported via
 * the return values so individual assertions can turn them into verdicts.
 */
export interface SandboxHandle {
  /** Run a shell command, optionally from `cwd` (relative to sandbox root). */
  exec(cmd: string, cwd?: string): Promise<ExecResult>;
  /** Return file contents, or `null` if the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Issue an HTTP request to a URL reachable from inside the sandbox. */
  httpRequest(request: HttpRequest): Promise<HttpResult>;
  /** Issue an HTTP GET to a URL reachable from inside the sandbox. */
  httpGet(url: string): Promise<HttpResult>;
}
