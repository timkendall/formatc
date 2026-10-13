// Port of vendor/bun/src/format/html/writer.rs: what the printer writes the document with: the builders of Prettier's `document/builders`,
// for the elements of `ir`.
//
// The printer of `ir` writes no line break on a line that is empty, Prettier's does: two of them in a row are an empty line. So this keeps
// track of whether anything has been written since the last line break, and asks for an empty line where Prettier gets one.
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { Formatter } from "../ir/formatter.ts";
import {
  CURSOR_REGION_END,
  CURSOR_REGION_START,
  LM_EMPTY,
  LM_HARD,
  LM_SOFT,
  LM_SOFT_EMPTY,
  LM_SOFT_OR_SPACE,
  LM_SOFT_OR_SPACE_EMPTY,
  token,
  twMultiline,
  twMultilineString,
} from "../ir/element.ts";

/** Whether the line is empty where the next element is printed. */
const EL_NO = 0;
/** If the line break before is one: that is up to the group that both are in. */
const EL_IF_GROUP_BREAKS = 1;
/** If the line break before is one: that is up to a group that has ended. */
const EL_IF_GROUP_HAS_BROKEN = 2;
const EL_YES = 3;

export const CURSOR_START: number = CURSOR_REGION_START;
export const CURSOR_END: number = CURSOR_REGION_END;

let newlines = new Uint8Array(64).fill(10);

/** One string to Prettier, whatever is in it: `buf[s, e)`. */
export function writeString(f: Formatter, buf: Uint8Array, s: number, e: number): void {
  let hasLineBreak = false;
  for (let i = s; i < e; i++) {
    if ((buf[i] | 0) === 10) {
      hasLineBreak = true;
      break;
    }
  }
  if (!hasLineBreak) {
    f.textBytes(buf, s, e);
    return;
  }
  let width = 0;
  let ls = s;
  for (;;) {
    let le = ls;
    while (le < e && (buf[le] | 0) !== 10) le = le + 1;
    width = width + f.stringWidth(buf, ls, le);
    if (le >= e) break;
    ls = le + 1;
  }
  f.textBytesWithWidth(buf, s, e, twMultilineString(width));
}

const stash = new ByteBuf(64);

export class Writer {
  f: Formatter;
  /** Line breaks right after each other that have not been written yet: what they are if the group is on one line (-1: none), and how many. */
  pendMode: number;
  pendCount: number;
  emptyKind: number;
  emptyGroup: number;
  /** How many `indent`s are around what is written, if nothing else has a say in where its lines start (-1: not known). */
  indentLevel: number;
  /** The attempts that are open: the slot, the `empty_line` (kind and group) and the indent level of each. */
  attempts: I32Vec;

  /**
   * `indentLevel`: how many `indent`s are around what is written, if that is known (-1: not). `isAtStart`: nothing has been written yet.
   */
  constructor(f: Formatter, indentLevel: number, isAtStart: boolean) {
    this.f = f;
    this.pendMode = -1;
    this.pendCount = 0;
    this.emptyKind = isAtStart ? EL_YES : EL_NO;
    this.emptyGroup = 0;
    this.indentLevel = indentLevel;
    this.attempts = new I32Vec(16);
  }

  newGroupId(): number {
    return this.f.groupId();
  }

  /** The column that the lines of what is written start in, if that does not depend on how the document is printed (-1: not known). */
  indentationWidth(): number {
    if (this.indentLevel < 0) return -1;
    return this.indentLevel * this.f.options.indentWidth;
  }

  // ───────────────────────────── line breaks ─────────────────────────────

  addLine(mode: number): void {
    if (this.pendMode < 0) {
      this.pendMode = mode;
      this.pendCount = 1;
    } else if (this.pendMode === LM_HARD) {
      this.pendCount = this.pendCount + 1;
    } else if (this.pendMode === LM_SOFT_OR_SPACE && mode === LM_SOFT) {
      this.pendCount = this.pendCount + 1;
    } else {
      this.pendMode = mode;
      this.pendCount = this.pendCount + 1;
    }
  }

  /** Writes the line breaks that are due. */
  flush(): void {
    if (this.pendMode < 0) return;
    const mode = this.pendMode;
    const count = this.pendCount;
    this.pendMode = -1;
    this.pendCount = 0;
    const f = this.f;
    if (this.emptyKind === EL_IF_GROUP_HAS_BROKEN) {
      const id = this.emptyGroup;
      f.startIfGroupBreaksId(id);
      this.writeLines(mode, count, true);
      f.endConditional();
      f.startIfGroupFitsId(id);
      this.writeLines(mode, count, false);
      f.endConditional();
    } else {
      this.writeLines(mode, count, this.emptyKind !== EL_NO);
    }
    if (mode === LM_HARD) {
      this.emptyKind = EL_YES;
    } else {
      this.emptyKind = EL_IF_GROUP_BREAKS;
    }
  }

  /** `isLineEmpty`: the printer leaves out the first on a line that is empty. */
  writeLines(mode: number, count: number, isLineEmpty: boolean): void {
    const f = this.f;
    const writtenByMode = isLineEmpty ? 0 : 1;
    if (mode === LM_HARD && isLineEmpty) {
      // The first is for the indentation that is due not to be written.
      f.startDedentToRoot();
      f.line(LM_HARD);
      if (newlines.length < count) newlines = new Uint8Array(count * 2).fill(10);
      f.textBytesWithWidth(newlines, 0, count, twMultiline(0));
      f.endDedentToRoot();
      f.line(LM_HARD);
    } else if (mode === LM_HARD && count > 2) {
      // The first ends the line, with the blanks at its end.
      f.line(LM_HARD);
      this.writeLines(mode, count - 1, true);
    } else {
      const withEmptyLine = count > writtenByMode;
      let m = mode;
      if (withEmptyLine) {
        if (mode === LM_SOFT) m = LM_SOFT_EMPTY;
        else if (mode === LM_SOFT_OR_SPACE) m = LM_SOFT_OR_SPACE_EMPTY;
        else m = LM_EMPTY;
      }
      f.line(m);
    }
  }

  /** The group with `id` has just ended, and the last thing in it is a line break. */
  noteLineAtEndOfGroup(id: number): void {
    this.emptyKind = EL_IF_GROUP_HAS_BROKEN;
    this.emptyGroup = id;
  }

  /** Something starts or ends that decides by itself whether the line breaks in it are line breaks. `keeps`: it is a group, a fill or an entry that starts. */
  tagPrelude(keeps: boolean): void {
    this.flush();
    // A line break in what starts here is one only if those of the group around it are.
    if (this.emptyKind === EL_IF_GROUP_BREAKS && !keeps) this.emptyKind = EL_NO;
  }

  line(): void {
    this.addLine(LM_SOFT_OR_SPACE);
  }
  softline(): void {
    this.addLine(LM_SOFT);
  }
  hardline(): void {
    this.addLine(LM_HARD);
  }

  breakParent(): void {
    this.flush();
    this.f.expandParent();
  }

  // ───────────────────────────── strings ─────────────────────────────

  noteText(buf: Uint8Array, e: number): void {
    this.emptyKind = e > 0 && (buf[e - 1] | 0) === 10 ? EL_YES : EL_NO;
  }

  /** A keyword or a punctuator. */
  token(handle: number): void {
    this.flush();
    this.emptyKind = EL_NO;
    this.f.token(handle);
  }

  tokenStr(text: string): void {
    this.flush();
    this.emptyKind = EL_NO;
    this.f.tokenStr(text);
  }

  /** `replaceEndOfLine(text)`: a line break in it is a `literalline`. `buf[s, e)` */
  text(buf: Uint8Array, s: number, e: number): void {
    if (s >= e) return;
    this.flush();
    this.noteText(buf, e);
    this.f.textBytes(buf, s, e);
  }

  /** A string that Prettier does not look into: a line break in it is a character without a width. */
  string(buf: Uint8Array, s: number, e: number): void {
    if (s >= e) return;
    this.flush();
    this.noteText(buf, e);
    writeString(this.f, buf, s, e);
  }

  /** The ASCII literal `s` as a text (no tab, no line break). */
  textLit(s: string): void {
    if (s.length === 0) return;
    this.flush();
    this.emptyKind = EL_NO;
    this.f.textStr(s);
  }

  /**
   * Starts a text that is built: append to the buffer that is returned from where it says (`builtStart`), then call `endBuilt`.
   */
  beginBuilt(): ByteBuf {
    return this.f.textBuf();
  }

  /** What has been appended to the texts of the document from `start` on. */
  endBuilt(start: number): void {
    const f = this.f;
    const buf = f.textBuf();
    if (buf.len <= start) return;
    if (this.pendMode >= 0) {
      // The line breaks that are due come first: they may write a text of their own.
      stash.reset();
      stash.append(buf.data, start, buf.len);
      buf.len = start;
      this.flush();
      const at = buf.len;
      buf.append(stash.data, 0, stash.len);
      this.emptyKind = (buf.data[buf.len - 1] | 0) === 10 ? EL_YES : EL_NO;
      f.endBuiltText(at);
      return;
    }
    this.emptyKind = (buf.data[buf.len - 1] | 0) === 10 ? EL_YES : EL_NO;
    f.endBuiltText(start);
  }

  /** `replaceEndOfLine(text.replaceAll(byte, replacement))` */
  textReplacing(buf: Uint8Array, s: number, e: number, byte: number, replacement: string): void {
    let found = false;
    for (let i = s; i < e; i++) {
      if ((buf[i] | 0) === byte) {
        found = true;
        break;
      }
    }
    if (!found) {
      this.text(buf, s, e);
      return;
    }
    const out = this.f.textBuf();
    const start = out.len;
    for (let i = s; i < e; i++) {
      const b = buf[i] | 0;
      if (b === byte) out.appendAscii(replacement);
      else out.push(b);
    }
    this.endBuilt(start);
  }

  /**
   * Text that another formatter has printed for lines that start where these do. A line break that is part of a text in it is `\r\n`: see
   * `FormatOptions::is_in_markdown`.
   */
  printedText(buf: Uint8Array, s: number, e: number): void {
    let rest = s;
    for (;;) {
      // Up to the first line break that is not part of a text.
      let end = rest;
      let hasLineBreaks = false;
      for (;;) {
        let at = end;
        while (at < e && (buf[at] | 0) !== 10) at = at + 1;
        if (at < e && at > rest && (buf[at - 1] | 0) === 13) {
          end = at + 1;
          hasLineBreaks = true;
          continue;
        }
        end = at;
        break;
      }
      if (!hasLineBreaks) {
        this.text(buf, rest, end);
      } else {
        const out = this.f.textBuf();
        const start = out.len;
        let i = rest;
        while (i < end) {
          const b = buf[i] | 0;
          if (b === 13 && i + 1 < end && (buf[i + 1] | 0) === 10) {
            out.push(10);
            i = i + 2;
          } else {
            out.push(b);
            i = i + 1;
          }
        }
        this.endBuilt(start);
      }
      if (end >= e) return;
      this.hardline();
      rest = end + 1;
    }
  }

  // ───────────────────────────── what has contents ─────────────────────────────

  startGroup(): void {
    this.tagPrelude(true);
    this.f.startGroup();
  }

  startGroupWith(shouldBreak: boolean, id: number): void {
    this.tagPrelude(true);
    this.f.startGroupWith(id, shouldBreak);
  }

  endGroup(): void {
    this.tagPrelude(false);
    this.f.endGroup();
  }

  startIndent(): void {
    this.flush();
    this.f.startIndent();
    if (this.indentLevel >= 0) this.indentLevel = this.indentLevel + 1;
  }

  endIndent(): void {
    this.flush();
    this.f.endIndent();
    if (this.indentLevel >= 0) this.indentLevel = this.indentLevel > 0 ? this.indentLevel - 1 : 0;
  }

  /** `dedentToRoot(softline)` */
  softlineDedentedToRoot(): void {
    this.flush();
    this.f.startDedentToRoot();
    this.softline();
    this.flush();
    this.f.endDedentToRoot();
  }

  /** `indentIfBreak(.., { groupId })`. Returns what to end it with. */
  startIndentIfBreak(groupId: number): number {
    this.flush();
    this.f.startIndentIfGroupBreaks(groupId);
    const level = this.indentLevel;
    this.indentLevel = -1;
    return level;
  }

  endIndentIfBreak(groupId: number, indentLevel: number): void {
    this.flush();
    this.f.endIndentIfGroupBreaks(groupId);
    this.indentLevel = indentLevel;
  }

  startFill(): void {
    this.tagPrelude(true);
    this.f.startFill();
  }

  endFill(): void {
    this.tagPrelude(false);
    this.f.endFill();
  }

  startItem(): void {
    this.tagPrelude(true);
    this.f.startEntry();
  }

  endItem(): void {
    this.tagPrelude(false);
    this.f.endEntry();
  }

  /** Starts what is only there if the group with the id is broken, or only if it is not. `groupId` 0: the group that it is in. */
  startIf(isBroken: boolean, groupId: number): void {
    this.tagPrelude(false);
    if (isBroken) {
      if (groupId !== 0) this.f.startIfGroupBreaksId(groupId);
      else this.f.startIfGroupBreaks();
    } else if (groupId !== 0) {
      this.f.startIfGroupFitsId(groupId);
    } else {
      this.f.startIfGroupFits();
    }
  }

  endIf(): void {
    this.tagPrelude(false);
    this.f.endConditional();
  }

  /** `ifBreak(softline, "", { groupId })` */
  softlineIfBreak(groupId: number): void {
    this.startIf(true, groupId);
    this.softline();
    this.endIf();
  }

  /** `ifBreak(text)` */
  tokenIfBreak(handle: number): void {
    this.startIf(true, 0);
    this.token(handle);
    this.endIf();
  }

  // ───────────────────────────── what somebody else writes ─────────────────────────────

  /** Before something that does not start and does not end with a line break is written by another formatter: returns where it starts. */
  beginForeign(): number {
    this.flush();
    return this.f.len();
  }

  endForeign(start: number): void {
    if (this.f.len() > start) this.emptyKind = EL_NO;
  }

  /** Starts something that may not become part of the document. */
  startAttempt(): void {
    this.flush();
    const a = this.attempts;
    a.push(this.f.startCapture());
    a.push(this.emptyKind);
    a.push(this.emptyGroup);
    a.push(this.indentLevel);
  }

  /** The start or the end of the part of the text that the cursor is in. */
  cursorMark(mark: number): void {
    this.flush();
    this.f.cursor(mark);
  }

  /** The same for something that is written behind a string that has not been written yet. */
  startAttemptBehindText(): void {
    this.startAttempt();
    this.emptyKind = EL_NO;
  }

  /** Ends it. It is part of the document if `isKept`. Returns that. */
  endAttempt(isKept: boolean): boolean {
    const a = this.attempts;
    const indentLevel = a.pop();
    const emptyGroup = a.pop();
    const emptyKind = a.pop();
    const slot = a.pop();
    if (isKept) {
      this.flush();
    } else {
      this.pendMode = -1;
      this.pendCount = 0;
      this.emptyKind = emptyKind;
      this.emptyGroup = emptyGroup;
      this.indentLevel = indentLevel;
    }
    const written = this.f.endCapture(slot);
    if (isKept && written >= 0) this.f.writeInterned(written);
    return isKept;
  }

  /**
   * Ends it. Returns what has been written, which is not part of the document yet (a capture handle), if `isKept` and it is something; else
   * -1.
   */
  endAttemptAsContent(isKept: boolean): number {
    const a = this.attempts;
    const indentLevel = a.pop();
    const emptyGroup = a.pop();
    const emptyKind = a.pop();
    const slot = a.pop();
    if (isKept) {
      this.flush();
    } else {
      this.pendMode = -1;
      this.pendCount = 0;
    }
    this.emptyKind = emptyKind;
    this.emptyGroup = emptyGroup;
    this.indentLevel = indentLevel;
    const written = this.f.endCapture(slot);
    return isKept && written >= 0 ? written : -1;
  }

  /** Ends what is written. */
  finish(): void {
    this.flush();
  }
}

// The tokens the printers share.
export const TK_SPACE: number = token(" ");
export const TK_EMPTY_DOUBLE_QUOTE: number = token('"');
void LM_EMPTY;
