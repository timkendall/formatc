// The file system, for the driver: port of vendor/bun/src/lint/driver/fs.rs.
import * as fs from "node:fs";

export const K_NONE = 0;
export const K_FILE = 1;
export const K_DIR = 2;
export const K_LINK = 3;

// Set by `kindAndSize` and `linkKindAndSize`.
export let outSize = 0;

// What is at `path`, following links: K_FILE, K_DIR or K_NONE (nothing, or neither).
export function kindAndSize(path: string): number {
  try {
    const st = fs.statSync(path);
    if (st.isFile()) {
      outSize = st.size;
      return K_FILE;
    }
    if (st.isDirectory()) {
      outSize = st.size;
      return K_DIR;
    }
    return K_NONE;
  } catch (e) {
    return K_NONE;
  }
}

// What is at `path`, which can be a link: K_FILE, K_DIR, K_LINK or K_NONE.
export function linkKindAndSize(path: string): number {
  try {
    const st = fs.lstatSync(path);
    if (st.isSymbolicLink()) {
      outSize = st.size;
      return K_LINK;
    }
    if (st.isFile()) {
      outSize = st.size;
      return K_FILE;
    }
    if (st.isDirectory()) {
      outSize = st.size;
      return K_DIR;
    }
    return K_NONE;
  } catch (e) {
    return K_NONE;
  }
}

export function kind(path: string): number {
  return kindAndSize(path);
}

export function isFile(path: string): boolean {
  return kindAndSize(path) === K_FILE;
}

export function exists(path: string): boolean {
  try {
    fs.statSync(path);
    return true;
  } catch (e) {
    return false;
  }
}

export let lastErrorCode = "";
export let lastErrorMessage = "";

// The text of a file as UTF-8, or null (with the error in `lastErrorCode`).
export function readText(path: string): string | null {
  try {
    const b = fs.readFileSync(path);
    lastErrorCode = "";
    return b.toString("utf8");
  } catch (e) {
    noteError(e);
    return null;
  }
}

export function noteError(e: unknown): void {
  const err = e as { code?: string; message?: string };
  lastErrorCode = err.code === undefined ? "" : err.code;
  lastErrorMessage = err.message === undefined ? "" : err.message;
}

// `ENOENT: No such file or directory`
export function describeError(code: string, fallback: string): string {
  if (code === "ENOENT") return "ENOENT: No such file or directory";
  if (code === "EACCES") return "EACCES: Permission denied";
  if (code === "EISDIR") return "EISDIR: Is a directory";
  if (code === "ENOTDIR") return "ENOTDIR: Not a directory";
  if (code === "EPERM") return "EPERM: Operation not permitted";
  if (code === "EFBIG") return "EFBIG: File too large";
  if (code === "ELOOP") return "ELOOP: Too many symbolic links encountered";
  if (code === "EMFILE") return "EMFILE: Too many open files";
  if (code === "EROFS") return "EROFS: Read-only file system";
  return code === "" ? fallback : code + ": " + fallback;
}

export class Entry {
  name: string;
  isDirectory: boolean;
  isLink: boolean;
  constructor(name: string, isDirectory: boolean, isLink: boolean) {
    this.name = name;
    this.isDirectory = isDirectory;
    this.isLink = isLink;
  }
}

// Lists the directory at `path`. null if it cannot be listed. Neither files, directories nor links are left out.
export function list(path: string): Entry[] | null {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(path, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  const out: Entry[] = [];
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const isLink = e.isSymbolicLink();
    const isDir = e.isDirectory();
    if (!isLink && !isDir && !e.isFile()) continue;
    out.push(new Entry(e.name, isDir, isLink));
  }
  return out;
}

// The first `n` bytes of the file at `path`, as latin1 text.
export function readStart(path: string, n: number): string {
  try {
    const fd = fs.openSync(path, "r");
    const buf = Buffer.alloc(n);
    let got = 0;
    try {
      got = fs.readSync(fd, buf, 0, n, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString("latin1", 0, got);
  } catch (e) {
    return "";
  }
}

export function realPath(path: string): string | null {
  try {
    return fs.realpathSync(path);
  } catch (e) {
    return null;
  }
}

export function readStdin(): Uint8Array | null {
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(65536);
    while (true) {
      let n = 0;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "EAGAIN") continue;
        if (code === "EOF") break;
        noteError(e);
        return null;
      }
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total = total + n;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], at);
      at = at + chunks[i].length;
    }
    return out;
  } catch (e) {
    noteError(e);
    return null;
  }
}

let tmpCounter = 0;

// Written next to the file and renamed (as Bun does) is 3x the system calls of writing in place (as Prettier does).
const ATOMIC_WRITES = process.env["FMT_ATOMIC_WRITES"] !== undefined;

// Replaces the text of the file at `path`. Written next to it and renamed, where that keeps the mode and the file has
// one name; otherwise in place. Returns "" or the reason.
export function writeFile(path: string, data: Uint8Array, len: number): string {
  try {
    let st: fs.Stats;
    try {
      st = fs.statSync(path);
    } catch (e) {
      noteError(e);
      return describeError(lastErrorCode, lastErrorMessage);
    }
    if (ATOMIC_WRITES && st.nlink <= 1) {
      tmpCounter = tmpCounter + 1;
      const tmp = path + "." + process.pid + "." + tmpCounter + ".tmp";
      let fd = -1;
      try {
        // the copy has the mode of the file
        fs.copyFileSync(path, tmp);
        fd = fs.openSync(tmp, "w");
        let off = 0;
        while (off < len) off = off + fs.writeSync(fd, data, off, len - off);
        fs.closeSync(fd);
        fd = -1;
        fs.renameSync(tmp, path);
        return "";
      } catch (e) {
        if (fd >= 0) {
          try {
            fs.closeSync(fd);
          } catch (e2) {
            // ignore
          }
        }
        try {
          fs.unlinkSync(tmp);
        } catch (e2) {
          // ignore
        }
        // fall back to writing in place
      }
    }
    const fd = fs.openSync(path, "w");
    let off = 0;
    while (off < len) off = off + fs.writeSync(fd, data, off, len - off);
    fs.closeSync(fd);
    return "";
  } catch (e) {
    noteError(e);
    return describeError(lastErrorCode, lastErrorMessage);
  }
}

// Writes a file that need not exist. Returns "" or the reason.
export function writeNew(path: string, data: Uint8Array): string {
  try {
    fs.writeFileSync(path, data);
    return "";
  } catch (e) {
    noteError(e);
    return describeError(lastErrorCode, lastErrorMessage);
  }
}
