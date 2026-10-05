# PR #1486 description notes

Do not open a new pull request. Update the existing description of https://github.com/shanalikhan/code-settings-sync/pull/1486 from these notes.

## Scope

Refs #413, criterion 8 only. This is Enterprise API groundwork, not the Git sync backend.

`src/service/git/enterpriseApi.ts` is a dependency-free HTTPS client for a GitHub Enterprise (`/api/v3`) or GitLab Enterprise (`/api/v4`) root.

- Create a private repository and list owned repositories (unchanged confinement).
- `getSettingsFile` / `putSettingsFile` read and replace one `settings-sync.json` on a named branch through the GitHub Contents API or the GitLab Files API.
- If that branch is missing and the repository has a default branch, the branch is created from the default branch, then the file is written. If the repository has no default branch, the file write is sent as the first commit.
- The upload replaces the file with a new commit. It does not rewrite history.

Confinement, unchanged for create/list and applied to put/get:

- The token is sent only to the configured API origin. Redirects are never followed.
- Pagination `Link` headers on another origin are refused before the next request. File responses that point at a `download_url` or other link are not followed.
- HTTPS clone URLs are returned only when their host matches, with port 443 normalized. For `api.github.com`, the clone host must be `github.com`.
- The token is never copied into URLs or error text.
- Certificate verification stays enabled. Responses are bounded (1 MiB) and requests time out (30 s). Settings text is bounded to 512 KiB.

## Verification

- eslint on `src/service/git/enterpriseApi.ts` and `test/service/git/enterpriseApi.test.ts` (0 warnings)
- `tsc` with the repo TypeScript 3.7 options (`module: commonjs`, `target: es5`, `noUnusedLocals`, `noUnusedParameters`) on those two files
- `npx mocha --timeout 20000 out/test/service/git/enterpriseApi.test.js` — 40 passing (the original 18 plus put/get, branch creation, host confinement, and redirect refusal)

Plain `tsc -p .` and `npm test` still fail on this checkout: current `@types/express-serve-static-core` and `@types/lodash` use syntax newer than TypeScript 3.7. That drift is outside this change.

## Still out of scope

Criteria 1–7 and 9, Gist coexistence, SSH, and a full Git remote. A stale GitHub blob SHA fails as HTTP 409 and is not retried. A GitLab write response does not include a new blob id (`sha` is null until a later get). This was not run against a live GitHub Enterprise or GitLab Enterprise host.
