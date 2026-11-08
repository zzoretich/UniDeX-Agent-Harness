// The registry of agent CLIs the app itself spawned (agent-computer D18): the bridge admits an MCP server only when its
// parent CLI is listed here. A CLI's computer connection can be claimed once; remove forgets the agent and its claim.

import type { Access } from "./gate";

export interface AgentRef {
  pid: number;
  host: "claude" | "codex";
  page: "chat" | "code";
  /** chat:<thread> | code:<terminal id> */
  key: string;
  label: string;
  place: string;
  access: Access;
}

export class AgentRegistry {
  private readonly agents = new Map<number, AgentRef>();
  private readonly claimed = new Set<number>();

  /** Registers an agent, or replaces the fields of one already registered. A live claim survives a replace: only remove then add re-arms it. */
  add(a: AgentRef): void {
    this.agents.set(a.pid, a);
  }

  remove(pid: number): void {
    this.agents.delete(pid);
    this.claimed.delete(pid);
  }

  get(pid: number): AgentRef | undefined {
    return this.agents.get(pid);
  }

  /** True once per registered pid: the first connection wins, a second is refused. */
  claim(pid: number): boolean {
    if (!this.agents.has(pid) || this.claimed.has(pid)) return false;
    this.claimed.add(pid);
    return true;
  }
}
