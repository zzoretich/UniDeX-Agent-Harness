// Unit tests import main-process modules for their pure functions only. In plain Node, require("electron") would try
// to download the Electron binary, so the unit-test bundle gets this empty stand-in instead. The names main imports are
// here, unset: the bundle reads them through this object, so a test that drives a module needing one (the Computer
// browser's session and file dialog) sets it here before use.
module.exports = { app: undefined, BrowserWindow: undefined, dialog: undefined, nativeImage: undefined, session: undefined, WebContentsView: undefined };
