import * as fs from "fs-extra";
import * as path from "path";

/**
 * A settings file, named the way GistService names gist files:
 * "settings.json", "snippets|go.json", "|customized_sync|.eslintrc".
 */
export interface FolderFile {
  name: string;
  content: string;
}

/** Same shape as the gist "cloudSettings" file, plus the names written by the last export. */
export interface FolderMetadata {
  lastUpload: Date | string;
  extensionVersion?: string;
  files?: string[];
}

export interface FolderFilter {
  ignoreUploadFiles: string[];
  ignoreUploadFolders: string[];
  supportedFileExtensions: string[];
}

export type FolderProblem = "notSet" | "notAbsolute" | "overlapsUserFolder";

export const METADATA_FILE = "cloudSettings";
export const CUSTOM_PREFIX = "|customized_sync|";
export const CUSTOM_FOLDER = "customized_sync";
export const KEYBINDINGS = "keybindings.json";
export const KEYBINDINGS_MAC = "keybindingsMac.json";
export const LOCK_FILE = ".settings-sync.lock";
const TEMP_SUFFIX = ".sync-tmp";
/** A lock older than this was left behind by an export that crashed. */
const STALE_LOCK_MS = 2 * 60 * 1000;

/** Maps a sync file name to a path relative to the sync folder. Throws on names that could escape it. */
export function ToRelativePath(name: string): string {
  const parts = name.startsWith(CUSTOM_PREFIX)
    ? [CUSTOM_FOLDER, name.slice(CUSTOM_PREFIX.length)]
    : name.split("|");
  const invalid = parts.some(
    part =>
      !part ||
      part === "." ||
      part === ".." ||
      /[\\/]/.test(part) ||
      part.includes("\0")
  );
  if (invalid) {
    throw new Error(`Sync: Invalid settings file name "${name}".`);
  }
  return path.join(...parts);
}

/** Inverse of ToRelativePath. */
export function ToFileName(relativePath: string): string {
  const parts = relativePath.split(/[\\/]/);
  if (parts.length === 2 && parts[0] === CUSTOM_FOLDER) {
    return CUSTOM_PREFIX + parts[1];
  }
  return parts.join("|");
}

export function IsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

/** Resolves symbolic links in the part of the path that already exists. */
export async function RealPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    return await fs.realpath(resolved);
  } catch (err) {
    const parent = path.dirname(resolved);
    if (err.code !== "ENOENT" || parent === resolved) {
      throw err;
    }
    return path.join(await RealPath(parent), path.basename(resolved));
  }
}

/**
 * The sync folder must be an absolute path that neither contains nor sits
 * inside the VS Code user folder, otherwise an export would copy into itself.
 */
export async function CheckFolder(
  folder: string,
  userFolder: string
): Promise<FolderProblem | null> {
  if (!folder || !folder.trim()) {
    return "notSet";
  }
  if (!path.isAbsolute(folder.trim())) {
    return "notAbsolute";
  }
  const [sync, user] = await Promise.all([
    RealPath(folder.trim()),
    RealPath(userFolder)
  ]);
  if (IsInside(sync, user) || IsInside(user, sync)) {
    return "overlapsUserFolder";
  }
  return null;
}

/** Name used in the folder for a file listed from the user folder (mirrors the gist upload). */
export function ExportName(
  name: string,
  isMac: boolean,
  universalKeybindings: boolean
): string {
  if (name === KEYBINDINGS && isMac && !universalKeybindings) {
    return KEYBINDINGS_MAC;
  }
  return name;
}

/**
 * Name to write in the user folder for a file read from the sync folder,
 * or null when this OS should skip it (mirrors the gist download).
 */
export function ImportName(
  name: string,
  isMac: boolean,
  universalKeybindings: boolean
): string | null {
  const macKeybindings = isMac && !universalKeybindings;
  if (name === KEYBINDINGS_MAC) {
    return macKeybindings ? KEYBINDINGS : null;
  }
  if (name === KEYBINDINGS) {
    return macKeybindings ? null : KEYBINDINGS;
  }
  return name;
}

function Time(value: Date | string | null | undefined): number {
  return value ? new Date(value).getTime() : NaN;
}

/** True when the folder holds the export this machine last imported or wrote. */
export function IsUpToDate(
  metadata: FolderMetadata | null,
  lastDownload: Date | string | null,
  lastUpload: Date | string | null
): boolean {
  const exported = Time(metadata && metadata.lastUpload);
  return (
    !isNaN(exported) &&
    (exported === Time(lastDownload) || exported === Time(lastUpload))
  );
}

/** True when another export reached the folder after this machine last imported or exported. */
export function HasNewerExport(
  metadata: FolderMetadata | null,
  lastDownload: Date | string | null,
  lastUpload: Date | string | null
): boolean {
  const exported = Time(metadata && metadata.lastUpload);
  if (isNaN(exported) || IsUpToDate(metadata, lastDownload, lastUpload)) {
    return false;
  }
  const known = Math.max(Time(lastDownload) || 0, Time(lastUpload) || 0);
  return exported > known;
}

/** Glob match for ignoreUploadFiles entries: "*" and "?" wildcards, matched on the file name. */
export function MatchesPattern(relativePath: string, pattern: string): boolean {
  const subject = pattern.includes("/")
    ? relativePath.split(path.sep).join("/")
    : path.basename(relativePath);
  const expression = pattern
    .split("")
    .map(character =>
      character === "*"
        ? "[^/]*"
        : character === "?"
        ? "[^/]"
        : character.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    )
    .join("");
  return new RegExp(`^${expression}$`).test(subject);
}

/** A plain folder (for example inside OneDrive or Dropbox) holding exported settings files. */
export class FolderStore {
  constructor(public readonly folder: string) {}

  public async ReadMetadata(): Promise<FolderMetadata | null> {
    const content = await this.ReadFile(METADATA_FILE);
    if (content === null) {
      return null;
    }
    let metadata: FolderMetadata;
    try {
      metadata = JSON.parse(content);
    } catch (err) {
      metadata = null;
    }
    if (!metadata || typeof metadata !== "object") {
      throw new Error(
        `Sync: ${path.join(this.folder, METADATA_FILE)} is not valid JSON.`
      );
    }
    return metadata;
  }

  /** Reads a file by sync name. Returns null when it is missing or is not a regular file. */
  public async ReadFile(name: string): Promise<string | null> {
    const target = path.join(this.folder, ToRelativePath(name));
    let stats: fs.Stats;
    try {
      stats = await fs.lstat(target);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        return null;
      }
      throw err;
    }
    if (
      !stats.isFile() ||
      !IsInside(await fs.realpath(this.folder), await fs.realpath(target))
    ) {
      return null;
    }
    return fs.readFile(target, "utf8");
  }

  /**
   * Lists the settings files in the folder with the same rules FileService.ListFiles
   * applies to the user folder. Symbolic links are never followed and the
   * customized_sync folder is left to ReadFile.
   */
  public async ListFiles(filter: FolderFilter): Promise<FolderFile[]> {
    const files: FolderFile[] = [];
    if (!(await fs.pathExists(this.folder))) {
      return files;
    }
    const walk = async (relativeFolder: string): Promise<void> => {
      const entries = (
        await fs.readdir(path.join(this.folder, relativeFolder))
      ).sort();
      for (const entry of entries) {
        const relative = path.join(relativeFolder, entry);
        const stats = await fs.lstat(path.join(this.folder, relative));
        if (
          stats.isSymbolicLink() ||
          filter.ignoreUploadFiles.some(pattern =>
            MatchesPattern(relative, pattern)
          )
        ) {
          continue;
        }
        if (stats.isDirectory()) {
          if (
            relative !== CUSTOM_FOLDER &&
            !filter.ignoreUploadFolders.includes(entry)
          ) {
            await walk(relative);
          }
          continue;
        }
        if (
          stats.isFile() &&
          !entry.endsWith(TEMP_SUFFIX) &&
          filter.supportedFileExtensions.includes(path.extname(entry).slice(1))
        ) {
          files.push({
            name: ToFileName(relative),
            content: await fs.readFile(path.join(this.folder, relative), "utf8")
          });
        }
      }
    };
    await walk("");
    return files;
  }

  /**
   * True when any of the files is missing from the folder or has different
   * content, or when the previous export wrote a file that is no longer exported.
   */
  public async HasChanges(
    files: FolderFile[],
    previous: FolderMetadata = null
  ): Promise<boolean> {
    const names = new Set(files.map(file => file.name));
    const removed =
      previous &&
      Array.isArray(previous.files) &&
      previous.files.some(
        name =>
          typeof name === "string" &&
          !names.has(name) &&
          !name.startsWith("keybindings")
      );
    if (removed) {
      return true;
    }
    for (const file of files) {
      if ((await this.ReadFile(file.name)) !== file.content) {
        return true;
      }
    }
    return false;
  }

  /**
   * Writes every file (each one atomically), removes files that the previous
   * export wrote but this one did not, then writes the metadata file last.
   * Keybinding files are kept so a shared folder keeps the other OS's bindings,
   * matching how the gist upload treats them.
   *
   * The work happens under a lock file so two machines exporting to a shared
   * folder cannot interleave. When `expected` (the metadata the caller compared
   * against) is given, the write is refused if another export landed since.
   */
  public async Write(
    files: FolderFile[],
    metadata: FolderMetadata,
    expected?: FolderMetadata | null
  ): Promise<void> {
    await fs.ensureDir(this.folder);
    const root = await fs.realpath(this.folder);
    const release = await this.Lock(root);
    try {
      await this.WriteLocked(root, files, metadata, expected);
    } finally {
      await release();
    }
  }

  private async Lock(root: string): Promise<() => Promise<void>> {
    const lockPath = path.join(root, LOCK_FILE);
    let handle: number;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      const stats = await fs.lstat(lockPath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs < STALE_LOCK_MS) {
        throw new Error(
          `Sync: Another export to ${this.folder} is in progress. Try again in a moment.`
        );
      }
      await fs.remove(lockPath);
      handle = await fs.open(lockPath, "wx");
    }
    return async () => {
      try {
        await fs.close(handle);
      } finally {
        await fs.remove(lockPath);
      }
    };
  }

  private async WriteLocked(
    root: string,
    files: FolderFile[],
    metadata: FolderMetadata,
    expected?: FolderMetadata | null
  ): Promise<void> {
    let previous: FolderMetadata = null;
    try {
      previous = await this.ReadMetadata();
    } catch (err) {
      previous = null;
    }
    const stamp = (value: FolderMetadata | null) =>
      value && value.lastUpload
        ? String(new Date(value.lastUpload).getTime())
        : "";
    if (expected !== undefined && stamp(previous) !== stamp(expected)) {
      throw new Error(
        `Sync: Another machine exported to ${this.folder} during this export. Run the export again.`
      );
    }
    const names = new Set<string>();
    for (const file of files) {
      const relative = ToRelativePath(file.name);
      if (file.name === METADATA_FILE || names.has(file.name)) {
        throw new Error(`Sync: Duplicate settings file name "${file.name}".`);
      }
      names.add(file.name);
      await this.WriteAtomic(root, relative, file.content);
    }
    const stale =
      previous && Array.isArray(previous.files) ? previous.files : [];
    for (const name of stale) {
      if (
        typeof name !== "string" ||
        names.has(name) ||
        name.startsWith("keybindings")
      ) {
        continue;
      }
      let target: string;
      try {
        target = path.join(root, ToRelativePath(name));
      } catch (err) {
        continue;
      }
      const stats = await fs.lstat(target).catch(() => null);
      if (
        stats &&
        stats.isFile() &&
        IsInside(root, await fs.realpath(path.dirname(target)))
      ) {
        await fs.remove(target);
      }
    }
    await this.WriteAtomic(
      root,
      METADATA_FILE,
      JSON.stringify({ ...metadata, files: Array.from(names).sort() }, null, 2)
    );
  }

  private async WriteAtomic(
    root: string,
    relative: string,
    content: string
  ): Promise<void> {
    const target = path.join(root, relative);
    await fs.ensureDir(path.dirname(target));
    if (!IsInside(root, await fs.realpath(path.dirname(target)))) {
      throw new Error(`Sync: Refusing to write outside ${root}: ${relative}`);
    }
    const temporary = `${target}.${process.pid}.${Date.now()}${TEMP_SUFFIX}`;
    try {
      await fs.writeFile(temporary, content, "utf8");
      await fs.rename(temporary, target);
    } finally {
      await fs.remove(temporary);
    }
  }
}
