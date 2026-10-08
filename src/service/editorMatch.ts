import * as path from "path";

export interface OpenDocument {
  fileName: string;
  isDirty: boolean;
}

export function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
