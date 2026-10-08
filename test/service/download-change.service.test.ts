import { expect } from "chai";

import {
  DownloadChangeService,
  IDownloadFileChange
} from "../../src/service/download-change.service";
import { File } from "../../src/service/file.service";
import { ExtensionInformation, PluginService } from "../../src/service/plugin.service";

function file(gistName: string): File {
  return new File(gistName, "remote", "", gistName);
}

function extension(name: string): ExtensionInformation {
  const item = new ExtensionInformation();
  item.name = name;
  item.publisher = "example";
  return item;
}

describe("DownloadChangeService", () => {
  it("previews extension replacements by publisher-qualified ID", () => {
    const local = extension("shared-name");
    local.publisher = "publisher-one";
    const remote = extension("shared-name");
    remote.publisher = "publisher-two";
    const original = PluginService.CreateExtensionList;
    PluginService.CreateExtensionList = () => [local];
    try {
      const remoteJson = JSON.stringify([
        {
          name: remote.name,
          publisher: remote.publisher,
          version: "1",
          metadata: {}
        }
      ]);
      const install = PluginService.GetMissingExtensions(remoteJson, []);
      const remove = PluginService.GetDeletedExtensions([remote], []);
      const summary = DownloadChangeService.FormatChangeSummary(
        DownloadChangeService.CreatePlan([], install, remove)
      );
      expect(install.map(ext => ext.publisher)).to.deep.equal(["publisher-two"]);
      expect(remove.map(ext => ext.publisher)).to.deep.equal(["publisher-one"]);
      expect(summary).to.contain("Extensions to install: publisher-two.shared-name");
      expect(summary).to.contain("Extensions to remove: publisher-one.shared-name");

      // The existing unqualified ignore list must still suppress this name.
      expect(PluginService.GetMissingExtensions(remoteJson, ["shared-name"])).to.deep.equal([]);
      expect(PluginService.GetDeletedExtensions([remote], ["shared-name"])).to.deep.equal([]);
      remote.publisher = "PUBLISHER-ONE";
      expect(PluginService.GetDeletedExtensions([remote], [])).to.deep.equal([]);
    } finally {
      PluginService.CreateExtensionList = original;
    }
  });


  it("excludes an unchanged effective file", () => {
    const change = DownloadChangeService.CreateFileChange(
      file("settings.json"),
      "/user/settings.json",
      "same",
      "same"
    );

    expect(change).to.equal(null);
  });

  it("keeps new and changed file actions in the same plan used by the preview", () => {
    const changes: IDownloadFileChange[] = [
      DownloadChangeService.CreateFileChange(
        file("settings.json"),
        "/user/settings.json",
        "new settings",
        "old settings"
      ),
      DownloadChangeService.CreateFileChange(
        file("tasks.json"),
        "/user/tasks.json",
        "new tasks",
        null
      )
    ].filter(Boolean) as IDownloadFileChange[];

    const plan = DownloadChangeService.CreatePlan(changes, [], []);

    expect(plan.fileChanges.map(change => change.action)).to.deep.equal([
      "updated",
      "created"
    ]);
    expect(DownloadChangeService.FormatChangeSummary(plan)).to.equal(
      [
        "Sync: The following remote changes will be downloaded.",
        "New: tasks.json",
        "Changed: settings.json"
      ].join("\n")
    );
  });

  it("cancellation gates the exact file and extension plan before application", async () => {
    const change = DownloadChangeService.CreateFileChange(
      file("settings.json"),
      "/user/settings.json",
      "remote",
      "local"
    )!;
    const plan = DownloadChangeService.CreatePlan(
      [change],
      [extension("install-me")],
      [extension("remove-me")]
    );

    let preview = "";
    const confirmed = await DownloadChangeService.ConfirmPlan(
      plan,
      false,
      async summary => {
        preview = summary;
        return false;
      }
    );

    expect(confirmed).to.equal(false);
    expect(preview).to.contain("Changed: settings.json");
    expect(preview).to.contain("Extensions to install: example.install-me");
    expect(preview).to.contain("Extensions to remove: example.remove-me");
  });

  it("does not prompt in quiet sync mode", async () => {
    const change = DownloadChangeService.CreateFileChange(
      file("settings.json"),
      "/user/settings.json",
      "remote",
      "local"
    )!;
    const plan = DownloadChangeService.CreatePlan([change], [], []);
    let prompts = 0;

    const confirmed = await DownloadChangeService.ConfirmPlan(
      plan,
      true,
      async () => {
        prompts += 1;
        return false;
      }
    );

    expect(confirmed).to.equal(true);
    expect(prompts).to.equal(0);
  });
});
