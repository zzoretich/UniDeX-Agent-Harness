// What the app's build answers for the HUD's nodeHost.ts (scripts/build.mjs): the page has no Node, and boot.ts installs
// the bridge host before the plugin loads. A HUD module that reached for the host while it was being imported, before
// boot, lands here and fails loudly instead of running half-hosted.
import type { HudHost } from "../../../../hud/src/host";

export function createNodeHost(): HudHost {
  throw new Error("UniDeX: the HUD reached for its host before the app installed one (no Node in this page)");
}
