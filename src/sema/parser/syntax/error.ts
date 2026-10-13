// The error that a check of this directory has found: `SyntaxError { at, message }` of syntax/mod.rs (a LEAF).
export class CheckSlot {
  has: boolean = false;
  message: string = "";
  at: number = 0;
}
export const check: CheckSlot = new CheckSlot();

export function setCheck(message: string, at: number, has: boolean): void {
  check.has = has;
  check.message = message;
  check.at = at;
}
