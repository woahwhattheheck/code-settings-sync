import { request as httpsRequest } from "https";
import { URL } from "url";

/**
 * Create and list repositories on a GitHub Enterprise or GitLab Enterprise API.
 *
 * `apiUrl` is the API root, such as https://github.example/api/v3 or
 * https://gitlab.example/api/v4. The token is sent only to that origin.
 * Redirects are not followed, and a pagination link on any other origin is
 * refused before a request is opened. HTTPS clone URLs are returned only when
 * their host matches; the token is never copied into them.
 */

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LIST_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30000;

export interface EnterpriseApiSettings {
  provider: string;
  apiUrl: string;
  token: string;
}

export interface EnterpriseRepository {
  name: string;
  cloneUrl: string;
  private: boolean;
}

export interface EnterpriseResponse {
  statusCode: number;
  headers: { [name: string]: string | string[] | undefined };
  body: string;
}

export interface EnterpriseTransport {
  (
    url: URL,
    method: "GET" | "POST",
    headers: { [name: string]: string },
    body?: string
  ): Promise<EnterpriseResponse>;
}

export interface EnterpriseCallOptions {
  /** Extra CA material. Certificate verification stays enabled. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Replaces the HTTPS client. Host checks still run before it is called. */
  transport?: EnterpriseTransport;
}

interface ValidatedApi {
  provider: "github" | "gitlab";
  api: URL;
  token: string;
}

export async function createPrivateRepository(
  settings: EnterpriseApiSettings,
  repositoryName: string,
  options?: EnterpriseCallOptions
): Promise<EnterpriseRepository> {
  const validated = validateSettings(settings);
  if (!isRepositoryName(repositoryName)) {
    throw new Error(
      "Enter a repository name using letters, numbers, dots, underscores, or hyphens."
    );
  }
  const endpoint = joinApi(
    validated.api,
    validated.provider === "github" ? "/user/repos" : "/projects"
  );
  const payload =
    validated.provider === "github"
      ? { name: repositoryName, private: true, auto_init: false }
      : {
          name: repositoryName,
          path: repositoryName,
          visibility: "private",
          initialize_with_readme: false
        };
  const response = await callApi(
    validated,
    options,
    endpoint,
    "POST",
    JSON.stringify(payload)
  );
  if (isRedirect(response.statusCode)) {
    throw new Error(
      "The enterprise API redirected the request. Refusing to follow it with the token."
    );
  }
  if (response.statusCode !== 201) {
    throw new Error(httpFailure(response.statusCode));
  }
  return parseRepository(validated, parseObject(response.body), repositoryName);
}

export async function listOwnedRepositories(
  settings: EnterpriseApiSettings,
  options?: EnterpriseCallOptions
): Promise<EnterpriseRepository[]> {
  const validated = validateSettings(settings);
  const query =
    validated.provider === "github"
      ? "per_page=100&affiliation=owner"
      : "owned=true&simple=true&per_page=100";
  let next: URL | null = joinApi(
    validated.api,
    validated.provider === "github" ? "/user/repos" : "/projects",
    query
  );
  const seen: string[] = [];
  const repositories: EnterpriseRepository[] = [];
  let pages = 0;

  while (next) {
    if (pages >= MAX_LIST_PAGES) {
      throw new Error("Provider listing exceeded 10 pages.");
    }
    if (seen.indexOf(next.href) !== -1) {
      throw new Error("The provider repeated a listing page.");
    }
    seen.push(next.href);
    pages++;
    const response = await callApi(validated, options, next, "GET");
    if (isRedirect(response.statusCode)) {
      throw new Error(
        "The enterprise API redirected the request. Refusing to follow it with the token."
      );
    }
    if (response.statusCode !== 200) {
      throw new Error(httpFailure(response.statusCode));
    }
    repositories.push(...parseRepositoryList(validated, response.body));
    next = nextPage(validated, response.headers);
  }
  return repositories;
}

function validateSettings(settings: EnterpriseApiSettings): ValidatedApi {
  if (settings.provider !== "github" && settings.provider !== "gitlab") {
    throw new Error("Select GitHub or GitLab for the enterprise API.");
  }
  if (!isToken(settings.token)) {
    throw new Error(
      "Enter an enterprise API token without spaces or line breaks."
    );
  }
  return {
    provider: settings.provider,
    api: parseApiRoot(settings.apiUrl),
    token: settings.token
  };
}

function parseApiRoot(apiUrl: string): URL {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch (_) {
    throw new Error(apiUrlMessage());
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new Error(apiUrlMessage());
  }
  return url;
}

function apiUrlMessage(): string {
  return "The enterprise API URL must be HTTPS without credentials, a query, or a fragment.";
}

function isToken(token: string): boolean {
  return (
    typeof token === "string" && /^[^\s]+$/.test(token) && token.length <= 4096
  );
}

function isRepositoryName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name);
}

function joinApi(api: URL, suffix: string, query?: string): URL {
  const endpoint = new URL(api.href);
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = basePath + suffix;
  endpoint.search = query ? "?" + query : "";
  endpoint.hash = "";
  assertTokenHost(api, endpoint);
  return endpoint;
}

function assertTokenHost(api: URL, target: URL): void {
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error(
      "Refusing to send the token to an unsafe repository API URL."
    );
  }
  if (originOf(api) !== originOf(target)) {
    throw new Error("Refusing to send the token to a different host.");
  }
}

function originOf(url: URL): string {
  return url.protocol + "//" + url.hostname + ":" + portOf(url);
}

function portOf(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "";
}

function tokenHeaders(validated: ValidatedApi): { [name: string]: string } {
  const headers: { [name: string]: string } = {
    Accept:
      validated.provider === "github"
        ? "application/vnd.github+json"
        : "application/json",
    "User-Agent": "code-settings-sync"
  };
  if (validated.provider === "github") {
    headers.Authorization = "token " + validated.token;
  } else {
    headers["PRIVATE-TOKEN"] = validated.token;
  }
  return headers;
}

async function callApi(
  validated: ValidatedApi,
  options: EnterpriseCallOptions | undefined,
  url: URL,
  method: "GET" | "POST",
  body?: string
): Promise<EnterpriseResponse> {
  assertTokenHost(validated.api, url);
  if (url.href.indexOf(validated.token) !== -1) {
    throw new Error(
      "Refusing to send the token to an unsafe repository API URL."
    );
  }
  const headers = tokenHeaders(validated);
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  const transport =
    options && options.transport
      ? options.transport
      : nodeTransport(options && options.ca);
  try {
    return await transport(url, method, headers, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message || message.indexOf(validated.token) !== -1) {
      throw new Error("The enterprise API request failed.");
    }
    throw new Error(message);
  }
}

function nodeTransport(ca: EnterpriseCallOptions["ca"]): EnterpriseTransport {
  return (url, method, headers, body) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const req = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method,
          headers,
          ca,
          servername: ipHostname(url.hostname) ? undefined : url.hostname
        },
        response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              fail(new Error("The provider response is too large."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({
              statusCode: response.statusCode || 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
          response.on("error", () => {
            fail(new Error("The enterprise API request failed."));
          });
        }
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        fail(new Error("The enterprise API request timed out."));
      });
      req.on("error", error => {
        fail(
          new Error(
            error && error.message
              ? error.message
              : "The enterprise API request failed."
          )
        );
      });
      req.end(body);
    });
}

function ipHostname(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].indexOf(statusCode) !== -1;
}

function httpFailure(statusCode: number): string {
  return "Enterprise API request failed (HTTP " + String(statusCode) + ").";
}

function parseObject(body: string): { [key: string]: unknown } {
  const value = parseJson(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The provider returned an unexpected repository.");
  }
  return value as { [key: string]: unknown };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new Error("The provider returned invalid JSON.");
  }
}

function parseRepositoryList(
  validated: ValidatedApi,
  body: string
): EnterpriseRepository[] {
  const value = parseJson(body);
  if (!Array.isArray(value)) {
    throw new Error("The provider returned an unexpected repository list.");
  }
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("The provider returned an unexpected repository.");
    }
    return parseRepository(validated, item as { [key: string]: unknown });
  });
}

function parseRepository(
  validated: ValidatedApi,
  record: { [key: string]: unknown },
  expectedName?: string
): EnterpriseRepository {
  const name =
    validated.provider === "github" ? record.name : record.path || record.name;
  const cloneUrl =
    validated.provider === "github"
      ? record.clone_url
      : record.http_url_to_repo;
  const isPrivate =
    validated.provider === "github"
      ? record.private
      : gitlabPrivate(record.visibility);
  if (typeof name !== "string" || !isRepositoryName(name)) {
    throw new Error("The provider returned an unexpected repository.");
  }
  if (expectedName && name !== expectedName) {
    throw new Error("The provider returned a different repository name.");
  }
  if (typeof isPrivate !== "boolean") {
    throw new Error("The provider returned an unexpected repository.");
  }
  return {
    name,
    cloneUrl: acceptedCloneUrl(validated, cloneUrl),
    private: isPrivate
  };
}

function gitlabPrivate(visibility: unknown): boolean | null {
  if (visibility === "private") {
    return true;
  }
  if (visibility === "public" || visibility === "internal") {
    return false;
  }
  return null;
}

function acceptedCloneUrl(validated: ValidatedApi, value: unknown): string {
  if (typeof value !== "string" || value.indexOf(validated.token) !== -1) {
    throw new Error(
      typeof value === "string" && value.indexOf(validated.token) !== -1
        ? "The provider returned a clone URL that contains the token."
        : "The provider did not return an HTTPS clone URL."
    );
  }
  let remote: URL;
  try {
    remote = new URL(value);
  } catch (_) {
    throw new Error("The provider did not return an HTTPS clone URL.");
  }
  if (
    remote.protocol !== "https:" ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash ||
    /\s/.test(value)
  ) {
    throw new Error("The provider did not return an HTTPS clone URL.");
  }
  const expectedHost =
    validated.provider === "github" &&
    validated.api.hostname === "api.github.com"
      ? "github.com"
      : validated.api.hostname;
  if (
    remote.hostname !== expectedHost ||
    portOf(remote) !== portOf(validated.api)
  ) {
    throw new Error("The provider returned a repository on a different host.");
  }
  return remote.href;
}

function nextPage(
  validated: ValidatedApi,
  headers: EnterpriseResponse["headers"]
): URL | null {
  const header = headers.link;
  const link = Array.isArray(header) ? header.join(",") : header || "";
  if (!link) {
    return null;
  }
  const parts = link.split(",");
  let target: string | null = null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!/rel="?next"?/i.test(part)) {
      continue;
    }
    const match = /<([^>]+)>/.exec(part);
    if (match) {
      target = match[1];
      break;
    }
  }
  if (!target) {
    return null;
  }
  if (target.indexOf(validated.token) !== -1) {
    throw new Error(
      "Refusing to send the token to an unsafe repository API URL."
    );
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch (_) {
    throw new Error("The provider returned an invalid pagination link.");
  }
  assertTokenHost(validated.api, url);
  return url;
}
