import * as fs from "fs";
import * as path from "path";

export interface OpenDocument {
  fileName: string;
  isDirty: boolean;
}

export function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  let canonical = resolved;
  try {
    // FileService.WriteFile follows symlinks. Resolve existing paths here too
    // so a dirty document opened through the real target cannot be missed when
    // Sync reaches the same file through a symlinked settings path.
    canonical = fs.realpathSync(resolved);
  } catch {
    // Download targets may not exist yet; lexical normalization is sufficient
    // until there is an on-disk identity to resolve.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * True when an open document for targetPath has unsaved changes. Writing the
 * file underneath such an editor makes VS Code report "The content on disk is
 * newer" and would also drop the user's unsaved edits.
 */
export function HasDirtyDocument(
  openDocuments: OpenDocument[],
  targetPath: string
): boolean {
  const target = normalizeFilePath(targetPath);
  return openDocuments.some(
    doc => doc.isDirty && normalizeFilePath(doc.fileName) === target
  );
}
