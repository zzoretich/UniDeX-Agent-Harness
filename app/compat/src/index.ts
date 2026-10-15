// The `obsidian` module as the AgenticOS app provides it. The build points every `import … from "obsidian"` in the
// Workbench HUD here. Importing it installs Obsidian's DOM helpers, which the HUD uses as globals.

import { installDomHelpers } from "./dom";

installDomHelpers();

export { DOM_HELPERS, createEl, createDiv, createSpan, createSvg, createFragment, type DomElementInfo } from "./dom";
export { Events, Component, type EventRef } from "./events";
export { TAbstractFile, TFile, TFolder, normalizePath, type FileStats } from "./files";
export { Vault, DataAdapter } from "./vault";
export { Workspace, WorkspaceLeaf, View, ItemView, NoteView, NoteView as MarkdownView, type ViewState } from "./workspace";
export { Modal, SuggestModal, FuzzySuggestModal, fuzzyScore, type FuzzyMatch } from "./modal";
export { Setting, ButtonComponent, ExtraButtonComponent, ToggleComponent, TextComponent, DropdownComponent } from "./setting";
export { MarkdownRenderer, setMarkdownHost } from "./markdown";
export { Notice, setIcon, getIconIds } from "./notice";
export { App, Plugin, SettingTab, PluginSettingTab, Commands, type PluginManifest, type Command, type Hotkey } from "./plugin";
export { guardState, setWriteGuard, canSave, canWrite, canRun, refuse, type GuardEntry, type GuardState, type WriteGuard } from "./guard";
export { setBridge } from "./bridge";

// The app is macOS only (D2). The page has no `process`: the platform is what the browser reports.
const nav = (globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? "";
const mac = /^Mac/i.test(nav);
export const Platform = { isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false, isMacOS: mac, isWin: /^Win/i.test(nav), isLinux: /Linux/i.test(nav) };
export const apiVersion = "1.13.1-compat";
