// The peer addon (agent-computer D18): Node has no peer-credential or code-signature API, so the bridge admits a
// connection through app/native/peer, the app's own Node-API addon. peerPid reads the pid at the other end of a Unix
// socket (LOCAL_PEERPID); procInfo reads a process's parent, executable and argv (null when it is gone or not this
// user's to read). teamId reads the Apple team that signed the file at an absolute path, the check before a launch;
// processTeamId reads the team of the code a running process runs, the check at admission, which a binary renamed over
// the process's path cannot change and which does not hash the whole file. Both are null when the code is unsigned, ad
// hoc or invalid. Packaged, the addon is unpacked beside the archive, like node-pty's pty.node, so it loads as a plain
// signed file.

import { app } from "electron";
import type net from "node:net";
import path from "node:path";

export interface ProcInfo { pid: number; ppid: number; path: string; argv: string[] }
export interface PeerAddon {
  peerPid(fd: number): number;
  procInfo(pid: number): ProcInfo | null;
  teamId(path: string): string | null;
  processTeamId(pid: number): string | null;
}

const ADDON = path.join("native", "peer", "build", "Release", "peer.node");

/** Where scripts/build-native.mjs builds it: app.asar.unpacked when packaged, the app folder in a dev or e2e run. */
function addonPath(): string {
  const root = app.getAppPath();
  return path.join(app.isPackaged && path.basename(root) === "app.asar" ? `${root}.unpacked` : root, ADDON);
}

/** Loads the addon (the tests name the built file; the app takes its own). */
export function loadPeer(file: string = addonPath()): PeerAddon {
  return require(file) as PeerAddon;
}

/** The accepted socket's file descriptor, for peerPid. Throws when the socket has none (not connected, or closed). */
export function socketFd(s: net.Socket): number {
  const fd = (s as unknown as { _handle?: { fd?: unknown } | null })._handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) throw new Error("the socket has no file descriptor");
  return fd;
}
