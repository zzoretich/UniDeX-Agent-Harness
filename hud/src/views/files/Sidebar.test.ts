import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFavoritePaths, editFavorites, favoritesFrom } from "./Sidebar";

const folders = (...paths: string[]) => (p: string) => paths.includes(p);

test("the default favorites (files-finder D20): the vault, Brain, Memory, Workspaces, the newest year, Persona", () => {
  assert.deepEqual(defaultFavoritePaths(["2025", "2026"]), ["", "brain", "brain/memory", "workspaces", "2026", "persona"]);
  assert.deepEqual(defaultFavoritePaths([]), ["", "brain", "brain/memory", "workspaces", "persona"]);
  const shown = favoritesFrom(null, "Vault", folders("brain", "workspaces", "2026"), ["2026"]);
  assert.deepEqual(shown.map((f) => [f.path, f.label, f.icon]), [
    ["", "Vault", "house"], ["brain", "Brain", "brain"], ["workspaces", "Workspaces", "folder"], ["2026", "Daily notes", "calendar"],
  ], "only the folders that exist; the vault always");
});

test("a user's favorites: their order, their folder's name, a default keeping its own; gone ones hidden", () => {
  const shown = favoritesFrom(["workspaces/harbor-map", "brain", "gone"], "Vault", folders("workspaces/harbor-map", "brain"), []);
  assert.deepEqual(shown.map((f) => [f.path, f.label, f.icon]), [["workspaces/harbor-map", "harbor-map", "folder"], ["brain", "Brain", "brain"]]);
  assert.deepEqual(favoritesFrom([], "Vault", folders(), []), []);
});

test("editing favorites: an added folder goes at the end once, a removed one comes out, the defaults are the start", () => {
  assert.deepEqual(editFavorites(null, ["2026"], { add: ["workspaces/harbor-map", "brain"] }), ["", "brain", "brain/memory", "workspaces", "2026", "persona", "workspaces/harbor-map"]);
  assert.deepEqual(editFavorites(null, [], { remove: "brain/memory" }), ["", "brain", "workspaces", "persona"]);
  assert.deepEqual(editFavorites(["a", "b"], [], { add: ["c"], remove: "a" }), ["b", "c"]);
  assert.deepEqual(editFavorites(["a"], [], {}), ["a"]);
});
