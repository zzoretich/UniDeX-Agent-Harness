'use strict';
/**
 * brand-assets.test.js — structural invariants for the generated brand SVGs.
 *
 * These assets are served to anyone viewing the repository, through GitHub's
 * image proxy, so the generator is held to three promises: it can only ever
 * emit inert markup, it may only paint with the declared palette, and it is
 * byte-stable across runs. The last one is what keeps "generated and
 * committed" honest — an unstable generator produces phantom diffs, and
 * phantom diffs train people to stop running it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { build, PALETTE, ASSET_NAMES, ANIMATED } = require('./brand-assets.js');

// A minimal well-formedness check: every element that opens must close, in
// order. Enough to catch the mistakes a string-building generator actually
// makes; the generator emits no comments, no prolog and no `>` inside an
// attribute value, which is what lets a regex stand in for a parser here.
function unbalanced(svg) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const [, closing, name, , selfClose] = m;
    if (closing) {
      if (stack.pop() !== name) return `stray </${name}>`;
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

const built = build();
const palette = new Set(Object.values(PALETTE).map(v => v.toLowerCase()));

test('builds exactly the declared asset list', () => {
  assert.deepEqual([...built.keys()].sort(), [...ASSET_NAMES].sort());
});

test('every asset is a well-formed, labelled svg', () => {
  for (const [name, svg] of built) {
    assert.equal(unbalanced(svg), null, `${name}: ${unbalanced(svg)}`);
    assert.match(svg, /^<svg /, `${name} does not start with <svg`);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name} lacks xmlns`);
    assert.match(svg, /role="img"/, `${name} lacks role="img"`);
    assert.match(svg, /aria-label="[^"]+"/, `${name} lacks a non-empty aria-label`);
    assert.equal(svg.endsWith('</svg>\n'), true, `${name} does not end with </svg>`);
  }
});

test('no asset can execute anything', () => {
  for (const [name, svg] of built) {
    assert.doesNotMatch(svg, /<script/i, `${name} contains <script>`);
    assert.doesNotMatch(svg, /<foreignObject/i, `${name} contains <foreignObject>`);
    assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, `${name} contains an event handler attribute`);
    assert.doesNotMatch(svg, /javascript:/i, `${name} contains a javascript: url`);
    assert.doesNotMatch(svg, /<(a|image|use)\b/i, `${name} references or links to something external`);
  }
});

test('every colour comes from the declared palette', () => {
  for (const [name, svg] of built) {
    for (const hex of svg.match(/#[0-9a-fA-F]{3,8}/g) || []) {
      assert.equal(palette.has(hex.toLowerCase()), true, `${name} paints with off-palette ${hex}`);
    }
  }
});

test('ampersands are always escaped', () => {
  for (const [name, svg] of built) {
    assert.doesNotMatch(svg, /&(?!(amp|lt|gt|quot|apos|#\d+);)/, `${name} has a bare &`);
  }
});

test('build is byte-stable across runs', () => {
  const again = build();
  assert.deepEqual([...again.keys()].sort(), [...built.keys()].sort());
  for (const [name, svg] of built) {
    assert.equal(again.get(name), svg, `${name} is not byte-identical on a second build`);
  }
});

test('the banner credits its author in the accessible label', () => {
  const banner = built.get('banner.svg');
  const label = banner.match(/aria-label="([^"]+)"/)[1];
  assert.match(label, /Zach Zoretich/, 'banner aria-label omits the author');
  assert.match(label, /UniDeX/, 'banner aria-label omits the product');
});

test('the download button says what it downloads and for which platform', () => {
  const button = built.get('download.svg');
  const label = button.match(/aria-label="([^"]+)"/)[1];
  assert.match(label, /UniDeX/, 'download aria-label omits the product');
  assert.match(label, /macOS/, 'download aria-label omits the platform');
  assert.doesNotMatch(button, /\d+\.\d+\.\d+/, 'download art names a version, which goes stale with the next release');
});

test('only the declared assets animate, and they really do', () => {
  for (const [name, svg] of built) {
    const animates = (svg.match(/<animate\b/g) || []).length;
    if (ANIMATED.has(name)) {
      assert.ok(animates > 0, `${name} is declared animated but has no <animate>`);
      assert.match(svg, /repeatCount="indefinite"/, `${name} animates once instead of looping`);
    } else {
      assert.equal(animates, 0, `${name} is declared static but has ${animates} <animate>`);
    }
  }
});

test('icons are transparent so they read on both GitHub themes', () => {
  for (const [name, svg] of built) {
    if (!name.startsWith('icon-')) continue;
    // No full-bleed background rect starting at the origin.
    assert.doesNotMatch(svg, /<rect x="0" y="0"/, `${name} paints an opaque background tile`);
  }
});
