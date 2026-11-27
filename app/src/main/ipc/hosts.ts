// hosts:* — what Code needs of the host CLIs (remove-sessions D11; services/hosts.ts checks everything). The page asks for
// the catalog of models and commands, and may ask the hosts again; it names nothing else.

import { CH } from "../../shared/ipc";
import type { HostService } from "../services/hosts";
import { HostsCatalogArgs } from "./schemas";
import { onInvoke, type Trust } from "./trust";

export function registerHostsIpc(trust: Trust, hosts: HostService): void {
  onInvoke(CH.hostsCatalog, trust, HostsCatalogArgs, ({ refresh }) => hosts.catalog(refresh === true));
}
