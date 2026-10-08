import { execFile } from "child_process";
import * as fs from "fs-extra";
import * as path from "path";
import { URL } from "url";
import * as vscode from "vscode";
import { CustomConfig } from "../../models/customConfig.model";
import { ISyncService } from "../../models/ISyncService.model";
import { IExtensionState } from "../../models/state.model";

interface GitRunResult {
  changed: boolean;
  pushed: boolean;
}

class GitCommandRunner {
  public run(cwd: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd }, (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).trim();
          reject(new Error("Git " + args[0] + " failed: " + detail));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }
}

export class GitRepositorySyncService implements ISyncService {
  private runner = new GitCommandRunner();

  constructor(private state: IExtensionState) {}

  public async IsConfigured(): Promise<boolean> {
    const customSettings = await this.state.commons.GetCustomSettings();
    if (
      !customSettings ||
      !customSettings.repositorySync ||
      customSettings.repositorySync.mode !== "repository"
    ) {
      return false;
    }
    try {
      this.remote(customSettings.repositorySync.remoteUrl);
      this.branch(customSettings.repositorySync.branch);
      return true;
    } catch (_) {
      return false;
    }
  }

  public async Reset(): Promise<void> {
    return;
  }

  public async Export(_optArgument?: unknown[]): Promise<void> {
    const localConfig = await this.state.commons.InitalizeSettings();
    const customSettings = localConfig.customConfig;
    const remote = this.remote(customSettings.repositorySync.remoteUrl);
    const branch = this.branch(customSettings.repositorySync.branch);

    await this.state.watcher.HandleStopWatching();
    try {
      vscode.window.setStatusBarMessage(
        "Sync: Saving settings to the configured Git repository...",
        2000
      );
      const result = await this.upload(
        this.state.environment.USER_FOLDER,
        remote,
        branch,
        customSettings
      );
      vscode.window.setStatusBarMessage(
        result.pushed
          ? "Sync: Settings were pushed to the Git repository."
          : result.changed
          ? "Sync: Settings were committed locally."
          : "Sync: The Git repository already contains the latest settings.",
        5000
      );
    } finally {
      if (localConfig.extConfig.autoUpload) {
        await this.state.watcher.HandleStartWatching();
      }
    }
  }

  public async Import(_optArgument?: unknown[]): Promise<void> {
    const localConfig = await this.state.commons.InitalizeSettings();
    const customSettings = localConfig.customConfig;
    const remote = this.remote(customSettings.repositorySync.remoteUrl);
    const branch = this.branch(customSettings.repositorySync.branch);

    await this.state.watcher.HandleStopWatching();
    try {
      vscode.window.setStatusBarMessage(
        "Sync: Downloading settings from the configured Git repository...",
        2000
      );
      await this.download(
        this.state.environment.USER_FOLDER,
        remote,
        branch,
        customSettings
      );
      vscode.window.setStatusBarMessage(
        "Sync: Settings were downloaded from the Git repository.",
        5000
      );
    } finally {
      if (localConfig.extConfig.autoUpload) {
        await this.state.watcher.HandleStartWatching();
      }
    }
  }

  private async upload(
    directory: string,
    remote: string,
    branch: string,
    customSettings: CustomConfig
  ): Promise<GitRunResult> {
    await this.initialize(directory, branch);
    await this.writeManagedExcludes(directory, customSettings);
    await this.ensureRemote(directory, remote);
    await this.runner.run(directory, ["add", "--all"]);

    const changed = Boolean(
      await this.runner.run(directory, ["status", "--porcelain"])
    );
    if (changed) {
      await this.runner.run(directory, [
        "-c",
        "user.name=Settings Sync",
        "-c",
        "user.email=settings-sync@localhost",
        "commit",
        "-m",
        "Sync settings"
      ]);
    }

    await this.runner.run(directory, [
      "push",
      "--force-with-lease",
      "--set-upstream",
      "origin",
      branch
    ]);
    return { changed, pushed: true };
  }

  private async download(
    directory: string,
    remote: string,
    branch: string,
    customSettings: CustomConfig
  ): Promise<void> {
    await this.initialize(directory, branch);
    await this.writeManagedExcludes(directory, customSettings);
    await this.ensureRemote(directory, remote);
    await this.runner.run(directory, ["fetch", "--prune", "origin", branch]);
    await this.runner.run(directory, [
      "checkout",
      "--force",
      "-B",
      branch,
      "origin/" + branch
    ]);
    await this.runner.run(directory, ["reset", "--hard", "origin/" + branch]);
    // Force-download updates tracked settings; never erase unrelated untracked
    // VS Code user files with `git clean -fd` in the entire user directory.
  }

  private async initialize(directory: string, branch: string): Promise<void> {
    await fs.ensureDir(directory);
    await this.runner.run(directory, ["check-ref-format", "--branch", branch]);
    if (!(await fs.pathExists(path.join(directory, ".git")))) {
      await this.runner.run(directory, ["init"]);
    }
    await this.ensureBranch(directory, branch);
  }

  private async ensureBranch(directory: string, branch: string): Promise<void> {
    let current = "";
    try {
      current = await this.runner.run(directory, [
        "symbolic-ref",
        "--short",
        "HEAD"
      ]);
    } catch (_) {
      current = "";
    }
    if (current === branch) {
      return;
    }
    try {
      await this.runner.run(directory, ["checkout", branch]);
    } catch (_) {
      await this.runner.run(directory, ["checkout", "-b", branch]);
    }
  }

  private async ensureRemote(directory: string, remote: string): Promise<void> {
    let current = "";
    try {
      current = await this.runner.run(directory, ["remote", "get-url", "origin"]);
    } catch (_) {
      current = "";
    }
    if (!current) {
      await this.runner.run(directory, ["remote", "add", "origin", remote]);
    } else if (current !== remote) {
      await this.runner.run(directory, ["remote", "set-url", "origin", remote]);
    }
  }

  private async writeManagedExcludes(
    directory: string,
    customSettings: CustomConfig
  ): Promise<void> {
    const excludePath = path.join(directory, ".git", "info", "exclude");
    const start = "# Settings Sync managed ignores";
    const end = "# End Settings Sync managed ignores";
    const existing = (await fs.pathExists(excludePath))
      ? await fs.readFile(excludePath, "utf8")
      : "";
    const pattern = new RegExp(start + "[\\s\\S]*?" + end + "\\n?", "g");
    const unmanaged = existing.replace(pattern, "").trim();
    const managed = [
      start,
      ...customSettings.ignoreUploadFiles,
      ...customSettings.ignoreUploadFolders.map(folder => {
        const normalized =
          folder.charAt(folder.length - 1) === "/"
            ? folder.substring(0, folder.length - 1)
            : folder;
        return normalized + "/";
      }),
      end,
      ""
    ].join("\n");
    await fs.ensureDir(path.dirname(excludePath));
    await fs.writeFile(
      excludePath,
      (unmanaged ? unmanaged + "\n" : "") + managed
    );
  }

  private remote(value: string): string {
    const remote = String(value || "").trim();
    if (!remote || /[\0\r\n]/.test(remote)) {
      throw new Error("Configure a Git repository remote URL before syncing.");
    }
    if (/^(?:http|git):\/\//i.test(remote)) {
      throw new Error(
        "Use HTTPS, SSH, or a local repository path for repository sync."
      );
    }
    if (/^https:\/\//i.test(remote) || /^ssh:\/\//i.test(remote)) {
      const parsed = new URL(remote);
      if (parsed.password || (parsed.protocol === "https:" && parsed.username)) {
        throw new Error(
          "Do not embed repository credentials in the remote URL; use Git credential configuration or SSH."
        );
      }
    }
    return remote;
  }

  private branch(value: string): string {
    const branch = String(value || "").trim();
    if (!branch || /[\0\r\n]/.test(branch)) {
      throw new Error("Configure a repository branch/profile before syncing.");
    }
    return branch;
  }
}
