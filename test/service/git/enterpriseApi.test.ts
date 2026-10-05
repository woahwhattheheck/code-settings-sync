import { expect } from "chai";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { URL } from "url";

import {
  createPrivateRepository,
  EnterpriseApiSettings,
  EnterpriseResponse,
  EnterpriseTransport,
  listOwnedRepositories
} from "../../../src/service/git/enterpriseApi";

const TOKEN = "local-enterprise-token";

describe("enterprise repository API", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-sync-enterprise-")
  );
  const certificate = createCertificate(directory, "enterprise");
  const otherCertificate = createCertificate(directory, "other");

  describe("rejects unsafe settings before opening a request", () => {
    const calls: URL[] = [];
    const transport: EnterpriseTransport = url => {
      calls.push(url);
      return Promise.reject(new Error("transport should not be called"));
    };

    beforeEach(() => {
      calls.length = 0;
    });

    it("requires GitHub or GitLab", async () => {
      await expectRejection(
        createPrivateRepository(
          settings("bitbucket", "https://git.example/api"),
          "repo",
          { transport }
        ),
        "Select GitHub or GitLab for the enterprise API."
      );
      expect(calls).to.have.length(0);
    });

    it("requires an HTTPS API root without credentials or a query", async () => {
      const urls = [
        "http://git.example/api/v3",
        "https://user:secret@git.example/api/v3",
        "https://git.example/api/v3?token=" + TOKEN,
        "https://git.example/api/v3#fragment",
        "not a url"
      ];
      for (let index = 0; index < urls.length; index++) {
        await expectRejection(
          listOwnedRepositories(settings("github", urls[index], TOKEN), {
            transport
          }),
          "The enterprise API URL must be HTTPS without credentials, a query, or a fragment."
        );
      }
      expect(calls).to.have.length(0);
    });

    it("rejects tokens that could break the authorization header", async () => {
      const tokens = [
        "",
        "has space",
        "line\nbreak",
        "return\rtoken",
        " token"
      ];
      for (let index = 0; index < tokens.length; index++) {
        await expectRejection(
          createPrivateRepository(
            settings("gitlab", "https://gitlab.example/api/v4", tokens[index]),
            "settings",
            { transport }
          ),
          "Enter an enterprise API token without spaces or line breaks."
        );
      }
      expect(calls).to.have.length(0);
    });

    it("rejects repository names that are not a single path segment", async () => {
      await expectRejection(
        createPrivateRepository(
          settings("github", "https://git.example/api/v3", TOKEN),
          "../settings",
          { transport }
        ),
        "Enter a repository name using letters, numbers, dots, underscores, or hyphens."
      );
      expect(calls).to.have.length(0);
    });
  });

  describe("confines clone URLs and pagination to the API host", () => {
    it("accepts a github.com clone URL only for api.github.com", async () => {
      const created = await createPrivateRepository(
        settings("github", "https://api.github.com", TOKEN),
        "settings",
        {
          transport: fixed(201, {
            name: "settings",
            private: true,
            clone_url: "https://github.com/me/settings.git"
          })
        }
      );
      expect(created.cloneUrl).to.equal("https://github.com/me/settings.git");
      expect(created.private).to.equal(true);

      await expectRejection(
        createPrivateRepository(
          settings("github", "https://api.github.com", TOKEN),
          "settings",
          {
            transport: fixed(201, {
              name: "settings",
              private: true,
              clone_url: "https://github.example/me/settings.git"
            })
          }
        ),
        "The provider returned a repository on a different host."
      );
    });

    it("rejects a public GitHub clone URL for a GitHub Enterprise API", async () => {
      const seen: string[] = [];
      await expectRejection(
        createPrivateRepository(
          settings("github", "https://GitHub.Example/api/v3", TOKEN),
          "settings",
          {
            transport: (url, method, headers, body) => {
              seen.push(url.hostname + " " + method);
              expect(headers.Authorization).to.equal("token " + TOKEN);
              expect(headers["PRIVATE-TOKEN"]).to.equal(undefined);
              expect(url.href.indexOf(TOKEN)).to.equal(-1);
              expect(JSON.parse(body || "{}").private).to.equal(true);
              return jsonResponse(201, {
                name: "settings",
                private: true,
                clone_url: "https://github.com/me/settings.git"
              });
            }
          }
        ),
        "The provider returned a repository on a different host."
      );
      expect(seen).to.deep.equal(["github.example POST"]);
    });

    it("treats an explicit port 443 as the same host and rejects other ports", async () => {
      const created = await createPrivateRepository(
        settings("gitlab", "https://gitlab.example/api/v4", TOKEN),
        "settings",
        {
          transport: fixed(201, {
            path: "settings",
            visibility: "private",
            http_url_to_repo: "https://gitlab.example:443/group/settings.git"
          })
        }
      );
      expect(new URL(created.cloneUrl).hostname).to.equal("gitlab.example");
      expect(new URL(created.cloneUrl).port).to.equal("");

      await expectRejection(
        createPrivateRepository(
          settings("gitlab", "https://gitlab.example:8443/api/v4", TOKEN),
          "settings",
          {
            transport: fixed(201, {
              path: "settings",
              visibility: "private",
              http_url_to_repo: "https://gitlab.example/group/settings.git"
            })
          }
        ),
        "The provider returned a repository on a different host."
      );
    });

    it("does not request a pagination link on another host", async () => {
      const seen: string[] = [];
      await expectRejection(
        listOwnedRepositories(
          settings("github", "https://git.example/api/v3", TOKEN),
          {
            transport: url => {
              seen.push(url.href);
              return jsonResponse(
                200,
                [
                  {
                    name: "settings",
                    private: true,
                    clone_url: "https://git.example/me/settings.git"
                  }
                ],
                {
                  link:
                    '<https://attacker.example/api/v3/user/repos?page=2>; rel="next"'
                }
              );
            }
          }
        ),
        "Refusing to send the token to a different host."
      );
      expect(seen).to.deep.equal([
        "https://git.example/api/v3/user/repos?per_page=100&affiliation=owner"
      ]);
    });

    it("refuses a pagination link that contains the token", async () => {
      await expectRejection(
        listOwnedRepositories(
          settings("gitlab", "https://gitlab.example/api/v4", TOKEN),
          {
            transport: () =>
              jsonResponse(
                200,
                [
                  {
                    path: "settings",
                    visibility: "private",
                    http_url_to_repo:
                      "https://gitlab.example/group/settings.git"
                  }
                ],
                {
                  link:
                    "<https://gitlab.example/api/v4/projects?page=2&token=" +
                    TOKEN +
                    '>; rel="next"'
                }
              )
          }
        ),
        "Refusing to send the token to an unsafe repository API URL."
      );
    });

    it("follows a same-host next page and stops on a repeated page", async () => {
      const seen: string[] = [];
      const listed = await listOwnedRepositories(
        settings("gitlab", "https://gitlab.example/gitlab/api/v4", TOKEN),
        {
          transport: url => {
            seen.push(url.pathname + url.search);
            if (url.search.indexOf("page=2") === -1) {
              return jsonResponse(
                200,
                [
                  {
                    path: "office",
                    visibility: "private",
                    http_url_to_repo: "https://gitlab.example/group/office.git"
                  }
                ],
                {
                  link:
                    '<https://gitlab.example/gitlab/api/v4/projects?owned=true&page=2>; rel="next", <https://gitlab.example/gitlab/api/v4/projects?page=2>; rel="last"'
                }
              );
            }
            return jsonResponse(200, [
              {
                path: "home",
                visibility: "public",
                http_url_to_repo: "https://gitlab.example/group/home.git"
              }
            ]);
          }
        }
      );
      expect(seen).to.deep.equal([
        "/gitlab/api/v4/projects?owned=true&simple=true&per_page=100",
        "/gitlab/api/v4/projects?owned=true&page=2"
      ]);
      expect(listed.map(repository => repository.name)).to.deep.equal([
        "office",
        "home"
      ]);
      expect(listed[0].private).to.equal(true);
      expect(listed[1].private).to.equal(false);

      let repeats = 0;
      await expectRejection(
        listOwnedRepositories(
          settings("github", "https://git.example/api/v3", TOKEN),
          {
            transport: url => {
              repeats++;
              return jsonResponse(
                200,
                [
                  {
                    name: "settings",
                    private: true,
                    clone_url: "https://git.example/me/settings.git"
                  }
                ],
                { link: "<" + url.href + '>; rel="next"' }
              );
            }
          }
        ),
        "The provider repeated a listing page."
      );
      expect(repeats).to.equal(1);
    });

    it("stops after 10 listing pages", async () => {
      let calls = 0;
      await expectRejection(
        listOwnedRepositories(
          settings("github", "https://git.example/api/v3", TOKEN),
          {
            transport: url => {
              calls++;
              expect(url.protocol).to.equal("https:");
              const page = calls + 1;
              return jsonResponse(
                200,
                [
                  {
                    name: "settings",
                    private: true,
                    clone_url: "https://git.example/me/settings.git"
                  }
                ],
                {
                  link:
                    "<https://git.example/api/v3/user/repos?page=" +
                    String(page) +
                    '>; rel="next"'
                }
              );
            }
          }
        ),
        "Provider listing exceeded 10 pages."
      );
      expect(calls).to.equal(10);
    });

    it("hides tokens echoed by a failed response or a thrown client error", async () => {
      await expectRejection(
        createPrivateRepository(
          settings("github", "https://git.example/api/v3", TOKEN),
          "settings",
          {
            transport: () => jsonResponse(401, { message: TOKEN })
          }
        ),
        "Enterprise API request failed (HTTP 401)."
      );
      await expectRejection(
        listOwnedRepositories(
          settings("gitlab", "https://gitlab.example/api/v4", TOKEN),
          {
            transport: () => Promise.reject(new Error("connect " + TOKEN))
          }
        ),
        "The enterprise API request failed."
      );
    });

    it("rejects a clone URL that embeds the token", async () => {
      await expectRejection(
        createPrivateRepository(
          settings("github", "https://git.example/api/v3", TOKEN),
          "settings",
          {
            transport: fixed(201, {
              name: "settings",
              private: true,
              clone_url: "https://git.example/me/" + TOKEN + ".git"
            })
          }
        ),
        "The provider returned a clone URL that contains the token."
      );
    });
  });

  describe("uses the HTTPS client against an enterprise API host", function() {
    this.timeout(15000);

    it("creates and lists a private GitHub Enterprise repository", async () => {
      const server = await listen(certificate, hit => {
        expect(hit.authorization).to.equal("token " + TOKEN);
        expect(hit.privateToken).to.equal("");
        expect(hit.url.indexOf(TOKEN)).to.equal(-1);
        if (hit.method === "POST") {
          expect(hit.url).to.equal("/api/v3/user/repos");
          expect(JSON.parse(hit.body)).to.deep.equal({
            name: "settings",
            private: true,
            auto_init: false
          });
          return json(201, {
            name: "settings",
            private: true,
            clone_url: cloneUrl(server.port, "/me/settings.git")
          });
        }
        expect(hit.method).to.equal("GET");
        expect(hit.url).to.equal(
          "/api/v3/user/repos?per_page=100&affiliation=owner"
        );
        return json(200, [
          {
            name: "settings",
            private: true,
            clone_url: cloneUrl(server.port, "/me/settings.git")
          }
        ]);
      });
      try {
        const api = "https://127.0.0.1:" + String(server.port) + "/api/v3";
        const created = await createPrivateRepository(
          settings("github", api, TOKEN),
          "settings",
          { ca: certificate.cert }
        );
        expect(created).to.deep.equal({
          name: "settings",
          cloneUrl: cloneUrl(server.port, "/me/settings.git"),
          private: true
        });
        const listed = await listOwnedRepositories(
          settings("github", api, TOKEN),
          {
            ca: certificate.cert
          }
        );
        expect(listed).to.deep.equal([created]);
        expect(server.hits).to.have.length(2);
      } finally {
        await server.close();
      }
    });

    it("creates and lists a private GitLab Enterprise repository under a base path", async () => {
      const server = await listen(certificate, hit => {
        expect(hit.privateToken).to.equal(TOKEN);
        expect(hit.authorization).to.equal("");
        expect(hit.url.indexOf(TOKEN)).to.equal(-1);
        if (hit.method === "POST") {
          expect(hit.url).to.equal("/gitlab/api/v4/projects");
          expect(JSON.parse(hit.body).visibility).to.equal("private");
          return json(201, {
            path: "settings",
            visibility: "private",
            http_url_to_repo: cloneUrl(server.port, "/group/settings.git")
          });
        }
        expect(hit.url).to.equal(
          "/gitlab/api/v4/projects?owned=true&simple=true&per_page=100"
        );
        return json(200, [
          {
            path: "settings",
            visibility: "private",
            http_url_to_repo: cloneUrl(server.port, "/group/settings.git")
          }
        ]);
      });
      try {
        const api =
          "https://127.0.0.1:" + String(server.port) + "/gitlab/api/v4";
        const created = await createPrivateRepository(
          settings("gitlab", api, TOKEN),
          "settings",
          { ca: certificate.cert }
        );
        expect(created.cloneUrl).to.equal(
          cloneUrl(server.port, "/group/settings.git")
        );
        const listed = await listOwnedRepositories(
          settings("gitlab", api, TOKEN),
          {
            ca: certificate.cert
          }
        );
        expect(listed[0].name).to.equal("settings");
      } finally {
        await server.close();
      }
    });

    it("does not follow a redirect onto another port with the token", async () => {
      const attacker = await listen(certificate, () => json(200, []));
      const api = await listen(certificate, () => ({
        status: 302,
        headers: {
          Location: "https://127.0.0.1:" + String(attacker.port) + "/steal"
        },
        body: JSON.stringify({ token: TOKEN })
      }));
      try {
        await expectRejection(
          createPrivateRepository(
            settings(
              "github",
              "https://127.0.0.1:" + String(api.port) + "/api/v3",
              TOKEN
            ),
            "settings",
            { ca: certificate.cert }
          ),
          "The enterprise API redirected the request. Refusing to follow it with the token."
        );
        expect(api.hits).to.have.length(1);
        expect(api.hits[0].authorization).to.equal("token " + TOKEN);
        expect(attacker.hits).to.have.length(0);
      } finally {
        await api.close();
        await attacker.close();
      }
    });

    it("does not send the token when a live listing page points at another port", async () => {
      const attacker = await listen(certificate, () =>
        json(200, { stolen: TOKEN })
      );
      const api = await listen(certificate, () =>
        json(
          200,
          [
            {
              name: "settings",
              private: true,
              clone_url:
                "https://127.0.0.1:" + String(api.port) + "/me/settings.git"
            }
          ],
          {
            Link:
              "<https://127.0.0.1:" +
              String(attacker.port) +
              '/api/v3/user/repos?page=2>; rel="next"'
          }
        )
      );
      try {
        await expectRejection(
          listOwnedRepositories(
            settings(
              "github",
              "https://127.0.0.1:" + String(api.port) + "/api/v3",
              TOKEN
            ),
            { ca: certificate.cert }
          ),
          "Refusing to send the token to a different host."
        );
        expect(api.hits).to.have.length(1);
        expect(attacker.hits).to.have.length(0);
      } finally {
        await api.close();
        await attacker.close();
      }
    });

    it("does not send the token when the server certificate is not trusted", async () => {
      const server = await listen(certificate, () => json(201, {}));
      try {
        const error = await rejectionOf(
          createPrivateRepository(
            settings(
              "gitlab",
              "https://127.0.0.1:" + String(server.port) + "/api/v4",
              TOKEN
            ),
            "settings",
            { ca: otherCertificate.cert }
          )
        );
        expect(error.message.indexOf(TOKEN)).to.equal(-1);
        expect(server.hits).to.have.length(0);
      } finally {
        await server.close();
      }
    });
  });
});

function settings(
  provider: string,
  apiUrl: string,
  token: string = TOKEN
): EnterpriseApiSettings {
  return { provider, apiUrl, token };
}

function fixed(
  statusCode: number,
  body: { [key: string]: unknown }
): EnterpriseTransport {
  return () => jsonResponse(statusCode, body);
}

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: { [name: string]: string }
): Promise<EnterpriseResponse> {
  return Promise.resolve({
    statusCode,
    headers: headers || {},
    body: JSON.stringify(body)
  });
}

async function expectRejection(
  promise: Promise<unknown>,
  message: string
): Promise<void> {
  const error = await rejectionOf(promise);
  expect(error.message).to.equal(message);
  expect(error.message.indexOf(TOKEN)).to.equal(-1);
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the enterprise API call to fail.");
}

interface CertificatePair {
  cert: Buffer;
  key: Buffer;
}

function createCertificate(directory: string, name: string): CertificatePair {
  const key = path.join(directory, name + ".key");
  const cert = path.join(directory, name + ".crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost"
    ],
    { stdio: "pipe" }
  );
  return {
    cert: fs.readFileSync(cert),
    key: fs.readFileSync(key)
  };
}

interface Hit {
  method: string;
  url: string;
  authorization: string;
  privateToken: string;
  body: string;
}

interface LiveServer {
  port: number;
  hits: Hit[];
  close: () => Promise<void>;
}

function json(
  status: number,
  body: unknown,
  headers?: { [name: string]: string }
): { status: number; headers: { [name: string]: string }; body: string } {
  return {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: JSON.stringify(body)
  };
}

function cloneUrl(port: number, repositoryPath: string): string {
  return "https://127.0.0.1:" + String(port) + repositoryPath;
}

function listen(
  certificate: CertificatePair,
  handler: (
    hit: Hit
  ) => { status: number; headers?: { [name: string]: string }; body: string }
): Promise<LiveServer> {
  const hits: Hit[] = [];
  const server = https.createServer(
    { cert: certificate.cert, key: certificate.key },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        const hit: Hit = {
          method: request.method || "",
          url: request.url || "",
          authorization: String(request.headers.authorization || ""),
          privateToken: String(request.headers["private-token"] || ""),
          body: Buffer.concat(chunks).toString("utf8")
        };
        hits.push(hit);
        const result = handler(hit);
        response.writeHead(result.status, result.headers || {});
        response.end(result.body);
      });
    }
  );
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind to a port.");
      }
      resolve({
        port: address.port,
        hits,
        close: () =>
          new Promise(done => {
            server.close(() => done());
          })
      });
    });
  });
}
