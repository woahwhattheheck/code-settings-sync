import { expect } from "chai";
import { GitRepositorySyncService } from "../../../src/service/git/repositorySync.service";
import { IExtensionState } from "../../../src/models/state.model";

describe("repository sync managed ignores", () => {
  it("untracks ignored files using literal NUL-delimited paths without removing them from disk", async () => {
    const service = new GitRepositorySyncService({} as IExtensionState);
    const calls: string[][] = [];
    // Stub only the Git transport: the actual implementation must issue an
    // index-only removal before upload stages any new files.
    const subject = service as unknown as {
      runner: { run: (cwd: string, args: string[]) => Promise<string> };
      untrackIgnoredFiles: (cwd: string) => Promise<void>;
    };
    subject.runner = {
      run: async (_cwd, args) => {
        calls.push(args);
        return args[0] === "ls-files"
          ? "secret file.json\0-odd\nname.txt\0"
          : "";
      }
    };

    await subject.untrackIgnoredFiles("/home/profile");
    expect(calls).to.deep.equal([
      [
        "ls-files", "--cached", "--ignored", "--exclude-standard", "-z"
      ],
      [
        "rm", "--cached", "--force", "--",
        "secret file.json", "-odd\nname.txt"
      ]
    ]);
  });

  it("does not remove any index entry when all tracked paths remain allowed", async () => {
    const service = new GitRepositorySyncService({} as IExtensionState);
    const calls: string[][] = [];
    const subject = service as unknown as {
      runner: { run: (cwd: string, args: string[]) => Promise<string> };
      untrackIgnoredFiles: (cwd: string) => Promise<void>;
    };
    subject.runner = {
      run: async (_cwd, args) => {
        calls.push(args);
        return "";
      }
    };
    await subject.untrackIgnoredFiles("/home/profile");
    expect(calls).to.have.length(1);
    expect(calls[0][0]).to.equal("ls-files");
  });
});
