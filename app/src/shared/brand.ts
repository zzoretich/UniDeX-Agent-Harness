// The product's name as people see it (UniDeX spec D1): window titles, menus, the tray, the wizard, messages. Identifiers
// keep their names (the bundle id, the data folder, `aos`, the `agenticos` plugins, ~/AgenticOS); see the spec's copy rule.
// hud/src/brand.ts holds the same values for the HUD; tests/unit/brand.test.ts keeps the two equal.

export const BRAND = { name: "UniDeX", mark: "UDX" } as const;
