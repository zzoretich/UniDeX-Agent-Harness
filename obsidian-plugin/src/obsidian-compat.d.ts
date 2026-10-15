// What the app's compat layer (app/compat/src, which the app builds the HUD against as "obsidian") exports beyond
// Obsidian's own API, declared for the HUD's standalone typecheck (`tsc -p obsidian-plugin`, against the obsidian
// package's types). `npm run check:compat` in app/ fails if compat stops exporting a name imported from "obsidian".
export {};

declare module "obsidian" {
  /**
   * Whether an enabled HUD surface may write this absolute path (app/compat/src/guard.ts, the host's page policy).
   * Display only: main checks every write. Spaces asks it for TODO.md, so + to-do and Link to-dos… show "Needs the
   * To-Do surface's writes" instead of failing (spaces-redesign D35).
   */
  export function canWrite(target: unknown): boolean;
  /**
   * Whether an enabled surface runs `node <vault>/brain/scripts/<script> args…` (the host's page policy). Display only:
   * main checks every spawn. The Go-local card asks it, so with the `migrate` surface off it names the command for the
   * Code tab instead of offering buttons that would be refused (local-first A9).
   */
  export function canRun(script: string, args: readonly string[]): boolean;
}
