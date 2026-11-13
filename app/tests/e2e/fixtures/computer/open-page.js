#!/usr/bin/env node
'use strict';
// The Computer pane's spec (session-browser S23): what a dev server does when it opens its page. Runs the program named by
// $BROWSER with one address, as `open`-style libraries do, and ends with its status. In a UniDeX session $BROWSER is the
// app's opener; the spec's own recording stand-in is what it falls back to, so nothing here can reach a real browser.
const { spawnSync } = require('node:child_process');

const url = process.argv[2];
const browser = process.env.BROWSER;
if (!url || !browser) process.exit(2);
const r = spawnSync('/bin/sh', ['-c', browser + ' "$1"', 'sh', url], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
