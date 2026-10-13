// A file to format, and what the arguments stand for.
import type { Scope } from "./config.ts";

// A file to format.
export class Target {
  path: string;
  // In bytes, when it was found.
  size: number;
  scope: Scope;
  // It is in a directory that is an argument: nothing is said if there is no parser for it.
  ignoresUnknown: boolean;
  // It is an argument itself, so nothing has been asked yet about the directories that it is in.
  isNamed: boolean;
  // What the run has worked out about it while the search was still going on (see `Run.prepare`).
  prepared: boolean;
  language: number;
  wanted: boolean;
  // The index of its options among the option sets of the run, or -1 if they are not (yet) resolved.
  setId: number;
  // Why they could not be resolved ("" if they could).
  setError: string;
  // Whether it is to be formatted (set by `Run.prepare`).
  work: boolean;
  // Where it is in the queue of the workers: `2 * index + lane`, or -1.
  jobKey: number;
  constructor(path: string, size: number, scope: Scope, ignoresUnknown: boolean, isNamed: boolean) {
    this.path = path;
    this.size = size;
    this.scope = scope;
    this.ignoresUnknown = ignoresUnknown;
    this.isNamed = isNamed;
    this.prepared = false;
    this.language = 0;
    this.wanted = true;
    this.setId = -1;
    this.setError = "";
    this.work = false;
    this.jobKey = -1;
  }
}

// What the arguments stand for, in the order in which Prettier comes to it.
export class Expanded {
  target: Target | null;
  // For the user. The exit code is 2.
  error: string | null;
  constructor(target: Target | null, error: string | null) {
    this.target = target;
    this.error = error;
  }
}
