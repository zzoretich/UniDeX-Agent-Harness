// The door (session-browser S23): a Unix socket in the app's userData where a program running inside a session (a
// BROWSER opener, `gh`, a dev server) asks for ONE page to open in that session's browser. A client connects, writes one
// line {"id":"<32 hex>","url":"<address>"}, reads {"ok":true} or {"ok":false}, and the door ends the connection.
// The id is a secret that main puts in the session's environment, so it names a session without a process lookup. The
// door never reads, clicks or types: a page is opened, nothing else. No id is ever written to a log.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { linkUrl } from "../policy/computer-url";
import { realClock, type Clock } from "./asks";
import { listenPrivate, privateDir, shortDirIn, socketPathIn, unlinkIfBound } from "./unix-socket";

export const DOOR_PER_MINUTE = 6;
export const DOOR_LINE_MAX = 16 * 1024;
export const DOOR_IDLE_MS = 2000;
export const DOOR_CONNECTIONS = 16;
const MINUTE_MS = 60_000;
const ID = /^[0-9a-f]{32}$/;
/** The variable that carries a session's id to its opener. No KEY, SECRET or TOKEN in the name: a host's shell filter drops those. */
export const SESSION_VAR = "AOS_BROWSER_SESSION";
const OPENER = "unidex-open.js";
/** Characters a shell reads as part of one word, whatever the shell. */
const SHELL_WORD = /^[A-Za-z0-9._/@%+=:,-]+$/;

/** As `bridgeSocketPath`, with the file name door.sock. */
export function doorSocketPath(userData: string, tmp: string): string | null {
  return socketPathIn(userData, tmp, "door.sock");
}

/**
 * `<resources>/opener/unidex-open.js`, the command a session's BROWSER points at; null when it is not there. A host reads
 * BROWSER and BRAINSTORM_OPEN_CMD as a shell line, so the path is used as it is only when a shell reads it as one word
 * (SHELL_WORD); otherwise a 0700 copy goes in the door's own short folder in `tmp`, made again at every start; null when
 * that path is not one word either, or the copy fails.
 */
export function openerPath(o: { resources: string; tmp: string; userData: string }): string | null {
  const own = path.join(o.resources, "opener", OPENER);
  try { if (!fs.statSync(own).isFile()) return null; } catch { return null; }
  if (SHELL_WORD.test(own)) return own;
  const dir = shortDirIn(o.userData, o.tmp);
  const copy = path.join(dir, OPENER);
  if (!SHELL_WORD.test(copy)) return null;
  try {
    privateDir(dir, "the opener will not be copied into it");
    fs.rmSync(copy, { force: true });
    fs.copyFileSync(own, copy);
    fs.chmodSync(copy, 0o700);
    return copy;
  } catch { return null; }
}

export interface DoorOptions { path: string;
  /** The opener's path (openerPath); absent or null, no session gets the three variables. */
  opener?: string | null;
  /** Whether the Computer surface is on (default: always); off, `envFor` gives no session anything. */
  enabled?: () => boolean; open: (session: string, url: string) => void; log: (line: string) => void; clock?: Clock;
  /** How long a connection may stay silent (2 s; tests shorten it). */
  idleMs?: number }

export class ComputerDoor {
  private server: net.Server | null = null;
  private bound: { dev: number; ino: number } | null = null;
  private readonly conns = new Set<net.Socket>();
  /** Every live id and the session it names. */
  private readonly ids = new Map<string, string>();
  /** The ids a session made for itself, in order; `issue` answers the first. Ids that arrived by `move` are not here. */
  private readonly own = new Map<string, string[]>();
  /** Times of a session's accepted opens in the last minute (the limit is per session, not per id). */
  private readonly opens = new Map<string, number[]>();
  /** When the "more than 6 pages" line was last written for a session: it is written once a minute at most. */
  private readonly warned = new Map<string, number>();
  private readonly clock: Clock;

  constructor(private readonly o: DoorOptions) { this.clock = o.clock ?? realClock; }

  listening(): boolean { return this.server !== null; }

  async start(): Promise<boolean> {
    const { path: sockPath } = this.o;
    try {
      const server = net.createServer((s) => this.connection(s));
      server.on("error", () => {});
      this.bound = await listenPrivate(server, sockPath, "the door");
      this.server = server;
      return true;
    } catch (err) {
      this.o.log(`door: not listening (${err instanceof Error ? err.message : "unknown error"})`);
      return false;
    }
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    for (const s of this.conns) s.destroy();
    this.conns.clear();
    server?.close();
    const bound = this.bound;
    this.bound = null;
    unlinkIfBound(this.o.path, bound);
  }

  issue(session: string): string {
    const mine = this.own.get(session);
    if (mine && mine.length) return mine[0];
    const id = randomBytes(16).toString("hex");
    this.ids.set(id, session);
    this.own.set(session, [id]);
    return id;
  }

  /**
   * The three variables a session's processes get (session-browser S23): BROWSER and BRAINSTORM_OPEN_CMD, both the opener,
   * and AOS_BROWSER_SESSION, which carries the session's id, the door's socket and the BROWSER that was set before
   * (`base`'s, unless it is the opener itself). None while the door is down, there is no opener, or the Computer surface is off.
   */
  envFor(session: string, base: NodeJS.ProcessEnv): Record<string, string> {
    const opener = this.o.opener;
    if (!this.server || !opener || this.o.enabled?.() === false) return {};
    const prev = base.BROWSER && base.BROWSER !== opener ? base.BROWSER : null;
    const carried = JSON.stringify({ id: this.issue(session), door: this.o.path, prev });
    return { BROWSER: opener, BRAINSTORM_OPEN_CMD: opener, [SESSION_VAR]: Buffer.from(carried, "utf8").toString("base64url") };
  }

  /** Every id of `from` now names `to`, beside the ids `to` has; `to`'s own first id stays its first. */
  move(from: string, to: string): void {
    if (from === to) return;
    for (const [id, s] of this.ids) if (s === from) this.ids.set(id, to);
    this.own.delete(from);
    const times = this.opens.get(from);
    if (times) {
      this.opens.set(to, [...(this.opens.get(to) ?? []), ...times]);
      this.opens.delete(from);
    }
    this.warned.delete(from);
  }

  revoke(session: string): void {
    for (const [id, s] of this.ids) if (s === session) this.ids.delete(id);
    this.own.delete(session);
    this.opens.delete(session);
    this.warned.delete(session);
  }

  revokeAll(prefix: string): void {
    for (const s of new Set(this.ids.values())) if (s.startsWith(prefix)) this.revoke(s);
  }

  accept(line: string): boolean {
    try {
      const msg: unknown = JSON.parse(line);
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return false;
      const { id, url } = msg as { id?: unknown; url?: unknown };
      if (typeof id !== "string" || !ID.test(id)) return false;
      const session = this.ids.get(id);
      if (session === undefined) return false;
      const target = linkUrl(url);
      if (target === null) return false;
      const now = this.clock.now();
      // A time later than now (the clock moved back) counts as expired, so a jump cannot lock a session out.
      const recent = (this.opens.get(session) ?? []).filter((t) => t <= now && now - t < MINUTE_MS);
      if (recent.length >= DOOR_PER_MINUTE) {
        this.opens.set(session, recent);
        const last = this.warned.get(session);
        if (last === undefined || last > now || now - last >= MINUTE_MS) {
          this.warned.set(session, now);
          this.o.log(`door: ${session} asked for more than ${DOOR_PER_MINUTE} pages in a minute`);
        }
        return false;
      }
      recent.push(now);
      this.opens.set(session, recent);
      try {
        this.o.open(session, target);
      } catch {
        // Main's error text could carry the address, so it is not logged.
        this.o.log(`door: an open for ${session} failed`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private connection(sock: net.Socket): void {
    if (this.conns.size >= DOOR_CONNECTIONS) { sock.destroy(); return; }
    this.conns.add(sock);
    let buf = "";
    let done = false;
    let handled = false;   // the first whole line is the only one: later bytes are ignored
    sock.setEncoding("utf8");
    const end = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.conns.delete(sock);
      sock.destroy();
    };
    const timer = setTimeout(end, this.o.idleMs ?? DOOR_IDLE_MS);
    sock.on("error", end);
    sock.on("close", end);
    sock.on("data", (chunk: string) => {
      if (done || handled) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      const len = Buffer.byteLength(nl < 0 ? buf : buf.slice(0, nl));
      if (len > DOOR_LINE_MAX) return end();
      if (nl < 0) return;
      handled = true;
      clearTimeout(timer);
      const ok = this.accept(buf.slice(0, nl));
      sock.end(`${JSON.stringify({ ok })}\n`, () => end());
    });
  }
}
