// Host platform primitives for the runtime core.
//
// The runtime core imports every host-specific primitive (filesystem, path,
// crypto, subprocess) from THIS module and never from `node:*` directly. That
// makes the core host-agnostic: a non-Node platform (React Native on a phone,
// a browser, etc.) supplies its own `host` with the same surface, and swapping
// this one module re-targets the whole runtime — no changes to core logic.
//
// This is the Node implementation. It re-exports the real Node built-ins, so on
// a Node host behavior is identical to importing `node:*` directly. A mobile
// host would provide: `fs` over the app sandbox, a pure-JS `path`, `crypto`
// over WebCrypto, and an `execFileAsync` that reports subprocesses as
// unavailable (a phone has no shell).

import { promises as nodeFs } from "node:fs";
import nodePath from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const fs = nodeFs;
export const path = nodePath;
export { createHash, randomUUID } from "node:crypto";
export const execFileAsync = promisify(execFile);

/** Portable HTTP header bag (was node:http's IncomingHttpHeaders). */
export type HttpHeaders = Record<string, string | string[] | undefined>;
