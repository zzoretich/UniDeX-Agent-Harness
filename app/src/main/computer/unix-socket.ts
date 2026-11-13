// The private Unix sockets of the computer bridge and the door (agent-computer D18, session-browser S23): where they
// live and how they are bound, in one place so the two cannot drift apart.

import { createHash } from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";

/** sockaddr_un.sun_path holds 104 bytes on macOS, the last for the terminator. */
export const MAX_PATH_BYTES = 103;

/**
 * Where a socket named `file` listens: `<userData>/computer/<file>`, or, when that is too long for a Unix socket (a long
 * home folder), a short path of this data folder's own in the user's system temp folder (`tmp`: macOS's per-user 0700
 * `$TMPDIR`). Null when even that does not fit.
 */
export function socketPathIn(userData: string, tmp: string, file: string): string | null {
  const own = path.join(userData, "computer", file);
  if (Buffer.byteLength(own) <= MAX_PATH_BYTES) return own;
  const short = path.join(shortDirIn(userData, tmp), file);
  return Buffer.byteLength(short) <= MAX_PATH_BYTES ? short : null;
}

/** This data folder's own short folder in the user's temp folder: where a socket goes when its path in userData is too long. */
export function shortDirIn(userData: string, tmp: string): string {
  const id = createHash("sha256").update(path.resolve(userData)).digest("hex").slice(0, 12);
  return path.join(tmp, `unidex-computer-${id}`);
}

/**
 * Makes `dir` a private folder: it must be a real folder of this user's, never a link, and is made 0700 (the default and
 * the temp-folder path alike). Throws; `refusal` finishes the message ("<dir> is not a folder of this user's, so <refusal>").
 */
export function privateDir(dir: string, refusal: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const d = fs.lstatSync(dir);
  if (!d.isDirectory() || (typeof process.getuid === "function" && d.uid !== process.getuid())) throw new Error(`${dir} is not a folder of this user's, so ${refusal}`);
  fs.chmodSync(dir, 0o700);
}

/**
 * Makes `server` listen at `socketPath` for this user only, and returns the socket's identity. The folder must be a real
 * folder of this user's, never a link, and is made 0700; only a leftover socket at the path is replaced; the socket is
 * chmod 0600 after listen (the server is closed if that fails). Throws; `what` ("the bridge", "the door") names the
 * listener in its messages.
 */
export async function listenPrivate(server: net.Server, socketPath: string, what: string): Promise<{ dev: number; ino: number }> {
  if (Buffer.byteLength(socketPath) > MAX_PATH_BYTES) throw new Error(`${what} socket path is longer than ${MAX_PATH_BYTES} bytes: ${socketPath}`);
  privateDir(path.dirname(socketPath), `${what} will not listen in it`);
  // Only a leftover socket is replaced; a file, link or folder at the path is somebody's, so refuse.
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(socketPath); } catch { /* nothing there */ }
  if (st) {
    if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket, so ${what} will not replace it`);
    fs.unlinkSync(socketPath);
  }
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(socketPath, () => { server.off("error", rej); res(); });
  });
  try {
    fs.chmodSync(socketPath, 0o600);
    const b = fs.lstatSync(socketPath);
    return { dev: b.dev, ino: b.ino };
  } catch (err) {
    await new Promise<void>((res) => server.close(() => res()));
    throw err;
  }
}

/** After a server closed: libuv unlinks the path by name when a server closes; this only makes sure of it, and only when
 *  the path is still the socket this instance bound. */
export function unlinkIfBound(socketPath: string, bound: { dev: number; ino: number } | null): void {
  try {
    const now = fs.lstatSync(socketPath);
    if (bound && now.dev === bound.dev && now.ino === bound.ino) fs.unlinkSync(socketPath);
  } catch { /* already gone */ }
}
