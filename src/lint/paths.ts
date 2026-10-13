// The part of vendor/bun/src/lint/paths.rs that the formatter uses.

/** `paths::file_name(path)`: the name of the file at `path`, whichever separator it is written with: `path.win32.basename(path)`. */
export function fileName(path: string): string {
  let end = path.length;
  // trailing separators are not part of the name
  while (end > 0 && (path.charCodeAt(end - 1) === 47 || path.charCodeAt(end - 1) === 92)) end = end - 1;
  let start = end;
  while (start > 0) {
    const c = path.charCodeAt(start - 1);
    if (c === 47 || c === 92) break;
    start = start - 1;
  }
  // `C:` is a root, not a name: `path.win32.basename("C:")` is ""
  if (start === 0 && end >= 2 && path.charCodeAt(1) === 58) {
    const c0 = path.charCodeAt(0);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) start = 2;
  }
  return path.slice(start, end);
}
