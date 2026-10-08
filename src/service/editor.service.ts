import * as vscode from "vscode";

import { HasDirtyDocument, normalizeFilePath } from "./editorMatch";
import { FileService } from "./file.service";

export class EditorService {
  /**
   * Overwrites filePath during a download. Clean editors showing the file are
   * closed first. If any editor (visible or hidden) has unsaved changes for the
   * file, the write is skipped and the user is told why.
   */
  public static async WriteFile(
    filePath: string,
    content: string
  ): Promise<boolean> {
    if (HasDirtyDocument(vscode.workspace.textDocuments, filePath)) {
      vscode.window.showWarningMessage(
        `Sync : ${filePath} has unsaved changes in an editor and was not overwritten. Save or revert it, then download again.`
      );
      return false;
    }
    await EditorService.CloseCleanEditors(filePath);
    return FileService.WriteFile(filePath, content);
  }

  private static async CloseCleanEditors(filePath: string): Promise<void> {
    const target = normalizeFilePath(filePath);
    const editors = vscode.window.visibleTextEditors.filter(
      editor => normalizeFilePath(editor.document.fileName) === target
    );
    for (const editor of editors) {
      await vscode.window.showTextDocument(editor.document, {
        viewColumn: editor.viewColumn,
        preserveFocus: true,
        preview: false
      });
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor"
      );
    }
  }
}
