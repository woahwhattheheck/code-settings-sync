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
    // The leaf may not exist yet even though its parent does. Resolve that
    // parent so a new file reached through a symlink still has the same
    // identity as an unsaved document opened through the real parent.
    try {
      canonical = path.join(
        fs.realpathSync(path.dirname(resolved)),
        path.basename(resolved)
      );
    } catch {
      // Multiple missing ancestors have no on-disk identity yet; retain the
      // lexical normalization until their directory tree exists.
    }
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
