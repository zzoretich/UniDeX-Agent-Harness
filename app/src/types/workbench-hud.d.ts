// The Workbench HUD as the app sees it. The build points these names at ../hud; tsc
// sees only these shapes. The HUD's own tsc (hud/tsconfig.json) checks it against the `obsidian` types.

declare module "@workbench/hud" {
  import type { App, Plugin, PluginManifest } from "obsidian";

  /** What the app hands the launch sequence (hud/src/ui/launchSequence.ts LaunchDeps, tour C11). */
  export interface LaunchDeps {
    info: { firstTime: boolean; installed: boolean; behind: boolean };
    /** The runtime upgrade dialog; `then` runs once it closes. */
    runtime?: (then: () => void) => void;
    /** Records the vault as opened (attach.json). */
    noted?: () => void;
    /** Each step as it starts: runtime, go-local, import, core-tour, whats-new, checklist. */
    log?: (step: string) => void;
  }

  export default class AgenticOSPlugin extends Plugin {
    constructor(app: App, manifest: PluginManifest);
    /** Every dialog the app opens on its own at launch, one at a time; resolves with the steps shown. */
    runLaunchSequence(d: LaunchDeps): Promise<string[]>;
  }
}

// ../hud/package.json, read for its version only (a named import keeps the rest out of the bundle).
declare module "@workbench/hud-package" {
  export const version: string;
}
