import type { Int32 } from "@scriptc/types";

const CT = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  let k = 0;
  if (c === 32 || c === 9 || c === 10 || c === 13) k = 1;
  else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c >= 128) k = 2;
  else if (c >= 48 && c <= 57) k = 3;
  else if (c === 34 || c === 39 || c === 96) k = 4;
  else if (c === 47) k = 5;
  CT[c] = k;
}
const IDC = new Uint8Array(256);
for (let c = 0; c < 256; c++) IDC[c] = CT[c] === 2 || CT[c] === 3 ? 1 : 0;


function lexFree_plain(src: Uint8Array, out: Int32Array): number {
  const n = src.length;
  let pos  = 0;
  let nt  = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos++; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos++;
      while (pos < n && IDC[src[pos]] === 1) pos++;
      kind = 1;
    } else if (k === 3) {
      pos++;
      while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos++;
      kind = 2;
    } else if (k === 4) {
      pos++;
      while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos++; pos++; }
      pos++;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) {
      while (pos < n && src[pos] !== 10) pos++;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) {
      pos = pos + 2;
      while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos++;
      pos = pos + 2;
      kind = 4;
    } else {
      pos++;
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    nt++;
  }
  return nt;
}


function lexFree_or0(src: Uint8Array, out: Int32Array): number {
  const n = src.length | 0;
  let pos  = 0;
  let nt  = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos = (pos + 1) | 0; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos = (pos + 1) | 0;
      while (pos < n && IDC[src[pos]] === 1) pos = (pos + 1) | 0;
      kind = 1;
    } else if (k === 3) {
      pos = (pos + 1) | 0;
      while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos = (pos + 1) | 0;
      kind = 2;
    } else if (k === 4) {
      pos = (pos + 1) | 0;
      while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos = (pos + 1) | 0; pos = (pos + 1) | 0; }
      pos = (pos + 1) | 0;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) {
      while (pos < n && src[pos] !== 10) pos = (pos + 1) | 0;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) {
      pos = (pos + 2) | 0;
      while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos = (pos + 1) | 0;
      pos = (pos + 2) | 0;
      kind = 4;
    } else {
      pos = (pos + 1) | 0;
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    nt = (nt + 1) | 0;
  }
  return nt;
}


function lexFree_idxor0(src: Uint8Array, out: Int32Array): number {
  const n = src.length;
  let pos  = 0;
  let nt  = 0;
  while (pos < n) {
    const c = src[pos | 0];
    const k = CT[c];
    if (k === 1) { pos++; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos++;
      while (pos < n && IDC[src[pos | 0]] === 1) pos++;
      kind = 1;
    } else if (k === 3) {
      pos++;
      while (pos < n && (IDC[src[pos | 0]] === 1 || src[pos | 0] === 46)) pos++;
      kind = 2;
    } else if (k === 4) {
      pos++;
      while (pos < n && src[pos | 0] !== c) { if (src[pos | 0] === 92) pos++; pos++; }
      pos++;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1 | 0] === 47) {
      while (pos < n && src[pos | 0] !== 10) pos++;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1 | 0] === 42) {
      pos = pos + 2;
      while (pos + 1 < n && !(src[pos | 0] === 42 && src[pos + 1 | 0] === 47)) pos++;
      pos = pos + 2;
      kind = 4;
    } else {
      pos++;
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    nt++;
  }
  return nt;
}


function lexFree_int32(src: Uint8Array, out: Int32Array): number {
  const n = src.length | 0;
  let pos : Int32 = 0;
  let nt : Int32 = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos = (pos + 1) | 0; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos = (pos + 1) | 0;
      while (pos < n && IDC[src[pos]] === 1) pos = (pos + 1) | 0;
      kind = 1;
    } else if (k === 3) {
      pos = (pos + 1) | 0;
      while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos = (pos + 1) | 0;
      kind = 2;
    } else if (k === 4) {
      pos = (pos + 1) | 0;
      while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos = (pos + 1) | 0; pos = (pos + 1) | 0; }
      pos = (pos + 1) | 0;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) {
      while (pos < n && src[pos] !== 10) pos = (pos + 1) | 0;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) {
      pos = (pos + 2) | 0;
      while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos = (pos + 1) | 0;
      pos = (pos + 2) | 0;
      kind = 4;
    } else {
      pos = (pos + 1) | 0;
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    nt = (nt + 1) | 0;
  }
  return nt;
}


function lexFree_ntplain(src: Uint8Array, out: Int32Array): number {
  const n = src.length | 0;
  let pos  = 0;
  let nt  = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos = (pos + 1) | 0; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos = (pos + 1) | 0;
      while (pos < n && IDC[src[pos]] === 1) pos = (pos + 1) | 0;
      kind = 1;
    } else if (k === 3) {
      pos = (pos + 1) | 0;
      while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos = (pos + 1) | 0;
      kind = 2;
    } else if (k === 4) {
      pos = (pos + 1) | 0;
      while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos = (pos + 1) | 0; pos = (pos + 1) | 0; }
      pos = (pos + 1) | 0;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) {
      while (pos < n && src[pos] !== 10) pos = (pos + 1) | 0;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) {
      pos = (pos + 2) | 0;
      while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos = (pos + 1) | 0;
      pos = (pos + 2) | 0;
      kind = 4;
    } else {
      pos = (pos + 1) | 0;
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    nt++;
  }
  return nt;
}

function lexFree_ntplain2(src: Uint8Array, out: Int32Array): number {
  const n = src.length | 0;
  let pos  = 0;
  let nt  = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos = (pos + 1) | 0; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos = (pos + 1) | 0;
      while (pos < n && IDC[src[pos]] === 1) pos = (pos + 1) | 0;
      kind = 1;
    } else if (k === 3) {
      pos = (pos + 1) | 0;
      while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos = (pos + 1) | 0;
      kind = 2;
    } else if (k === 4) {
      pos = (pos + 1) | 0;
      while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos = (pos + 1) | 0; pos = (pos + 1) | 0; }
      pos = (pos + 1) | 0;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) {
      while (pos < n && src[pos] !== 10) pos = (pos + 1) | 0;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) {
      pos = (pos + 2) | 0;
      while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos = (pos + 1) | 0;
      pos = (pos + 2) | 0;
      kind = 4;
    } else {
      pos = (pos + 1) | 0;
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    nt = nt + 1;
  }
  return nt;
}


function lexFree_full0(src: Uint8Array, out: Int32Array): number {
  const n = src.length | 0;
  let pos  = 0;
  let nt  = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos = ((pos | 0) + 1) | 0; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n && IDC[src[pos]] === 1) pos = ((pos | 0) + 1) | 0;
      kind = 1;
    } else if (k === 3) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos = ((pos | 0) + 1) | 0;
      kind = 2;
    } else if (k === 4) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos = ((pos | 0) + 1) | 0; pos = ((pos | 0) + 1) | 0; }
      pos = ((pos | 0) + 1) | 0;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) {
      while (pos < n && src[pos] !== 10) pos = ((pos | 0) + 1) | 0;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) {
      pos = ((pos | 0) + 2) | 0;
      while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos = ((pos | 0) + 1) | 0;
      pos = ((pos | 0) + 2) | 0;
      kind = 4;
    } else {
      pos = ((pos | 0) + 1) | 0;
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    nt = ((nt | 0) + 1) | 0;
  }
  return nt;
}

export { lexFree_plain, lexFree_or0, lexFree_idxor0, lexFree_int32, lexFree_ntplain, lexFree_ntplain2, lexFree_full0 };
