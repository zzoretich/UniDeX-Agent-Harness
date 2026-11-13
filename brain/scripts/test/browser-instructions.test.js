'use strict';
// session-browser S15: the server's instructions name the UniDeX browser only inside a running app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserInstructions, BROWSER_INSTRUCTIONS } = require('../sdk/lib/browser-instructions.js');

const live = { readMarker: () => ({ computerSocket: '/s', pid: 1 }), alive: () => true };

test('a session inside the app is told about its browser', () => {
  const s = browserInstructions({ vault: '/v', ...live });
  assert.equal(s, BROWSER_INSTRUCTIONS);
  assert.ok(s.length <= 600);
  for (const word of ['UniDeX browser', 'computer_status', 'computer_open', 'localhost', 'untrusted']) assert.ok(s.includes(word), word);
});

test("the paragraph says an action's reply ends with the page, so a snapshot is for a page not just acted on (S16d)", () => {
  assert.ok(BROWSER_INSTRUCTIONS.includes("each reply ends with the page as it is now; computer_snapshot is for any other page"), BROWSER_INSTRUCTIONS);
  assert.ok(!BROWSER_INSTRUCTIONS.includes('computer_snapshot to read it'), BROWSER_INSTRUCTIONS);
  assert.ok(BROWSER_INSTRUCTIONS.includes('computer_open asks the user to turn it on'), BROWSER_INSTRUCTIONS);
  assert.ok(BROWSER_INSTRUCTIONS.length <= 600, String(BROWSER_INSTRUCTIONS.length));
});

test('a session outside the app is told nothing', () => {
  for (const marker of [null, {}, { computerSocket: '/s', computer: 'off' }, { computerSocket: '/s', computer: 'failed' }]) {
    assert.equal(browserInstructions({ vault: '/v', readMarker: () => marker, alive: () => true }), undefined);
  }
  assert.equal(browserInstructions({ vault: '/v', readMarker: live.readMarker, alive: () => false }), undefined);
  assert.equal(browserInstructions({ vault: '/v', readMarker: () => { throw new Error('x'); }, alive: () => true }), undefined);
});
