#!/usr/bin/env node
'use strict';
/**
 * brand-assets.js — regenerates every brand SVG under docs/assets/.
 *
 * Replaces the 8-bit pixel generator. Same discipline: one palette, pure
 * builders, committed output, `node tools/brand-assets.js` is idempotent.
 *
 * Three constraints shape everything here:
 *   - The assets are rendered by GitHub through its image proxy, inside an
 *     <img>. That strips nothing from the file, but it also means no external
 *     font can load and no stylesheet applies, so type uses a system stack
 *     and motion uses SMIL <animate> rather than CSS.
 *   - READMEs render in both GitHub themes, so icons are transparent and
 *     stroked in mid-tone accents that carry on light and dark alike.
 *   - The banner and divider are dark cards of their own, so they read the
 *     same on either theme, and the palette stays in the Primer dark family.
 *     The app's screenshots beside them (`npm run screens` in app/) come in
 *     light and dark.
 *
 * Invariants are pinned in brand-assets.test.js.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'assets');

// ---------------------------------------------------------------- palette --
// Every colour any asset may paint with. The test fails the build on anything
// off this list, so a one-off shade cannot quietly enter the brand.
const PALETTE = {
  bg: '#0d1117',
  surface: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  muted: '#8b949e',
  dim: '#6e7681',
  blue: '#58a6ff',
  green: '#3fb950',
  purple: '#bc8cff',
  amber: '#d29922',
  cyan: '#39d3f2',
  red: '#f85149',
};
const C = PALETTE;

// A system stack: inside an <img> no webfont can load, so the asset borrows
// the viewer's own UI face. Every text block is left-aligned or explicitly
// centred on its own anchor, which is what makes per-platform metric
// differences invisible instead of clipping a centred lockup.
const SANS = "ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function doc(attrs, label, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs} role="img" aria-label="${esc(label)}">`,
    ...body,
    '</svg>',
  ].join('\n') + '\n';
}

// A looping opacity pulse. Declared as SMIL because it needs no <style>
// block, which is the one thing GitHub's sanitiser would have to strip.
function pulse(from, to, dur, begin) {
  return `<animate attributeName="opacity" values="${from};${to};${from}" dur="${dur}" begin="${begin}" repeatCount="indefinite"/>`;
}

// ------------------------------------------------------------------ icons --
// Stroked line icons on a 48-unit grid, content inset to roughly 8..40 so
// they stay legible at the 36px the README renders them at. No fills and no
// background tile: the icon sits directly on whichever theme the reader uses.
const ICONS = {
  'icon-brain': {
    label: 'Memory',
    color: C.purple,
    body: [
      '<circle cx="16" cy="16" r="4.5"/>',
      '<circle cx="33" cy="15" r="4.5"/>',
      '<circle cx="24" cy="34" r="4.5"/>',
      '<path d="M20.5 15.9 L28.5 15.1"/>',
      '<path d="M17.9 20.2 L22.1 29.8"/>',
      '<path d="M31.2 19.2 L25.9 30"/>',
    ],
  },
  'icon-recall': {
    label: 'Recall',
    color: C.blue,
    body: ['<circle cx="21" cy="21" r="11"/>', '<path d="M29 29 L39 39"/>'],
  },
  'icon-session': {
    label: 'Session capture',
    color: C.cyan,
    body: ['<circle cx="24" cy="24" r="15"/>', '<path d="M24 15 V24.5 L31 28.5"/>'],
  },
  'icon-staff': {
    label: 'Chief of Staff',
    color: C.green,
    body: [
      '<circle cx="24" cy="18" r="7"/>',
      '<path d="M11 39 c0-7.2 5.8-13 13-13 s13 5.8 13 13"/>',
    ],
  },
  'icon-hud': {
    label: 'The HUD',
    color: C.blue,
    body: [
      '<rect x="8" y="10" width="32" height="28" rx="3"/>',
      '<path d="M8 19 H40"/>',
      '<path d="M19 19 V38"/>',
    ],
  },
  'icon-cost': {
    label: 'Cost',
    color: C.amber,
    body: [
      '<path d="M9 39 H39"/>',
      '<path d="M14 34 V27"/>',
      '<path d="M21 34 V20"/>',
      '<path d="M28 34 V14"/>',
      '<path d="M35 34 V24"/>',
    ],
  },
  'icon-install': {
    label: 'Installation',
    color: C.blue,
    body: [
      '<path d="M24 9 V28"/>',
      '<path d="M16 21 l8 8 8-8"/>',
      '<path d="M11 33 v6 h26 v-6"/>',
    ],
  },
  'icon-first': {
    label: 'Your first session',
    color: C.green,
    body: ['<path d="M14 40 V9"/>', '<path d="M14 11 h18 l-4 6 4 6 H14"/>'],
  },
  'icon-commands': {
    label: 'Commands',
    color: C.cyan,
    body: [
      '<rect x="8" y="10" width="32" height="28" rx="3"/>',
      '<path d="M15 20 l4 4 -4 4"/>',
      '<path d="M24 28 h9"/>',
    ],
  },
  // A sitemap rather than three boxes in a row: at 36px the short connectors
  // between inline boxes disappear and the icon reads as "ooo". Branching
  // vertically keeps the flow legible and matches the flowchart in that
  // section of the README.
  'icon-how': {
    label: 'How it works',
    color: C.blue,
    body: [
      '<rect x="18" y="8" width="12" height="9" rx="2"/>',
      '<rect x="7" y="31" width="12" height="9" rx="2"/>',
      '<rect x="29" y="31" width="12" height="9" rx="2"/>',
      '<path d="M24 17 V24"/>',
      '<path d="M13 24 H35"/>',
      '<path d="M13 24 V31"/>',
      '<path d="M35 24 V31"/>',
    ],
  },
  'icon-privacy': {
    label: 'Privacy',
    color: C.green,
    body: [
      '<path d="M24 8 l14 5 v11 c0 8 -6 13.5 -14 16 c-8 -2.5 -14 -8 -14 -16 V13 z"/>',
      '<path d="M18 24 l4.5 4.5 L31 20"/>',
    ],
  },
  'icon-dev': {
    label: 'Development',
    color: C.purple,
    body: [
      '<path d="M17 17 l-8 7 8 7"/>',
      '<path d="M31 17 l8 7 -8 7"/>',
      '<path d="M27 13 l-6 22"/>',
    ],
  },
  'icon-docs': {
    label: 'Docs',
    color: C.cyan,
    body: [
      '<path d="M24 14 c-3 -2.5 -7 -3.5 -13 -3.5 V34 c6 0 10 1 13 3.5"/>',
      '<path d="M24 14 c3 -2.5 7 -3.5 13 -3.5 V34 c-6 0 -10 1 -13 3.5"/>',
      '<path d="M24 14 V37.5"/>',
    ],
  },
};

function buildIcon(def) {
  return doc(
    'width="48" height="48" viewBox="0 0 48 48" fill="none"',
    `${def.label} icon`,
    [
      `<g stroke="${def.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">`,
      ...def.body,
      '</g>',
    ]
  );
}

// ----------------------------------------------------------------- banner --
// The status lights name the lifecycle the harness runs, with the Chief of
// Staff over it, so the banner reads as a live system rather than a logo.
// Staggered begins keep the row from breathing in unison, which is what makes
// it feel like telemetry.
const BANNER_LEDS = [
  ['PLAN', C.blue],
  ['BUILD', C.green],
  ['REVIEW', C.amber],
  ['SHIP', C.green],
  ['STAFF', C.purple],
];
// REVIEW is the widest label; 50 units between centres keeps a clear gap
// beside it at 9px on any platform's UI face.
const BANNER_LED_STEP = 50;

// The Line mark's 130 × 46 drawing (UniDeX spec D10).
const MARK_PATH = 'M6 6V26a14 14 0 0 0 28 0V6 M48 6V40H60a17 17 0 0 0 0-34H48Z M92 6L124 40 M124 6L92 40';

function buildBanner() {
  const body = [
    '<defs>',
    '<linearGradient id="card" x1="0" y1="0" x2="0" y2="1">',
    `<stop offset="0" stop-color="${C.surface}"/>`,
    `<stop offset="1" stop-color="${C.bg}"/>`,
    '</linearGradient>',
    '</defs>',
    `<rect x="0.5" y="0.5" width="959" height="199" rx="12" fill="url(#card)" stroke="${C.border}"/>`,

    // Mark: the UniDeX Line mark (U, D and X in one stroke weight with round
    // ends; app/build/icon.svg and the app's rail draw the same path), dark on
    // a light tile, as the app shows it in its dark theme. Its centre sits on
    // the wordmark/tagline pair, not on the whole text block — the attribution
    // reads as a footer line and should not drag the mark down.
    `<rect x="40" y="52" width="56" height="56" rx="14" fill="${C.text}"/>`,
    `<g transform="translate(49.8 73.56) scale(0.28)" stroke="${C.bg}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none">`,
    `<path d="${MARK_PATH}"/>`,
    '</g>',

    `<text x="120" y="86" font-family="${SANS}" font-size="38" font-weight="600" letter-spacing="-0.5" fill="${C.text}">UniDeX</text>`,
    `<text x="122" y="112" font-family="${SANS}" font-size="16" fill="${C.muted}">The Unified Agentic Development Harness</text>`,
    `<rect x="122" y="126" width="160" height="1.5" rx="0.75" fill="${C.border}"/>`,
    `<text x="122" y="151" font-family="${SANS}" font-size="13" letter-spacing="0.3" fill="${C.dim}">Created by Zach Zoretich</text>`,
  ];

  // The lamp labels share the tagline's baseline, so the right cluster is
  // tied to the lockup by a real alignment rather than parked arbitrarily.
  // The last lamp stays at x 900, a 60-unit margin from the card's right edge.
  let x = 900 - BANNER_LED_STEP * (BANNER_LEDS.length - 1);
  for (let i = 0; i < BANNER_LEDS.length; i++) {
    const [name, color] = BANNER_LEDS[i];
    body.push(
      `<circle cx="${x}" cy="93" r="4.5" fill="${color}" opacity="0.35">${pulse('0.35', '1', '3s', `${(i * 0.4).toFixed(1)}s`)}</circle>`,
      `<text x="${x}" y="112" font-family="${SANS}" font-size="9" letter-spacing="1.2" text-anchor="middle" fill="${C.muted}">${name}</text>`
    );
    x += BANNER_LED_STEP;
  }

  return doc(
    'width="960" height="200" viewBox="0 0 960 200" fill="none"',
    'UniDeX — the Unified Agentic Development Harness. Created by Zach Zoretich.',
    body
  );
}

// --------------------------------------------------------------- download --
// The README's one call to action, linked to the latest release page (the DMG
// carries its version in its name, so no direct link to it stays valid). A
// green fill reads as a button on both GitHub themes. The glyph sits at a
// fixed spot on the left and the label is centred on the space after it, so a
// wider or narrower UI face shifts the label evenly instead of crowding the
// right edge. No version in the art: the line under it in the README says
// what to run it on, and the release page says which version it is.
function buildDownload() {
  return doc('width="280" height="56" viewBox="0 0 280 56" fill="none"', 'Download UniDeX for macOS', [
    `<rect x="0" y="0" width="280" height="56" rx="12" fill="${C.green}"/>`,
    `<g stroke="${C.bg}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none">`,
    '<path d="M36 17V32"/>',
    '<path d="M30 26.5L36 32L42 26.5"/>',
    '<path d="M27 34V38H45V34"/>',
    '</g>',
    `<text x="158" y="34" font-family="${SANS}" font-size="17" font-weight="600" text-anchor="middle" fill="${C.bg}">Download for macOS</text>`,
  ]);
}

// ---------------------------------------------------------------- divider --
// A hairline that fades at both ends rather than butting into the page edge,
// with five accent ticks that brighten left to right like work moving along
// the pipeline.
const DIVIDER_TICKS = [
  [180, C.green],
  [330, C.cyan],
  [480, C.blue],
  [630, C.purple],
  [780, C.amber],
];

function buildDivider() {
  const body = [
    '<defs>',
    // Id deliberately contains a non-hex letter: the palette test extracts
    // /#[0-9a-fA-F]{3,8}/ from the output, so an id like "fade" would be
    // mistaken for a colour and fail the build.
    '<linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">',
    `<stop offset="0" stop-color="${C.border}" stop-opacity="0"/>`,
    `<stop offset="0.5" stop-color="${C.border}" stop-opacity="1"/>`,
    `<stop offset="1" stop-color="${C.border}" stop-opacity="0"/>`,
    '</linearGradient>',
    '</defs>',
    '<rect x="0" y="5.5" width="960" height="1" fill="url(#rule)"/>',
  ];

  for (let i = 0; i < DIVIDER_TICKS.length; i++) {
    const [tx, color] = DIVIDER_TICKS[i];
    body.push(
      `<rect x="${tx}" y="2" width="2.5" height="8" rx="1.25" fill="${color}" opacity="0.25">${pulse('0.25', '1', '4s', `${(i * 0.5).toFixed(1)}s`)}</rect>`
    );
  }

  return doc('width="960" height="12" viewBox="0 0 960 12" fill="none"', 'Section divider', body);
}

// ------------------------------------------------------------------ pulse --
const PULSE_LEDS = [
  ['SCAN', C.green],
  ['WRAP', C.green],
  ['COST', C.amber],
  ['BACKFILL', C.dim],
  ['STAFF', C.green],
  ['MAP', C.green],
  ['AWRAP', C.amber],
  ['BRAIN', C.green],
];

function buildPulse() {
  const body = [
    `<rect x="0.5" y="0.5" width="959" height="71" rx="10" fill="${C.surface}" stroke="${C.border}"/>`,
  ];
  for (let i = 0; i < PULSE_LEDS.length; i++) {
    const [name, color] = PULSE_LEDS[i];
    const cx = 95 + i * 110;
    body.push(
      `<circle cx="${cx}" cy="27" r="5" fill="${color}"/>`,
      `<text x="${cx}" y="51" font-family="${SANS}" font-size="10" letter-spacing="1.1" text-anchor="middle" fill="${C.muted}">${name}</text>`
    );
  }
  return doc(
    'width="960" height="72" viewBox="0 0 960 72" fill="none"',
    `The Pulse row: ${PULSE_LEDS.map(l => l[0]).join(' ')}`,
    body
  );
}

// -------------------------------------------------------------- made with --
function buildMadeWith() {
  return doc('width="220" height="36" viewBox="0 0 220 36" fill="none"', 'Made with Claude Code', [
    `<rect x="0.5" y="0.5" width="219" height="35" rx="8" fill="${C.surface}" stroke="${C.border}"/>`,
    `<circle cx="18" cy="18" r="4.5" fill="${C.purple}"/>`,
    `<text x="31" y="22.5" font-family="${SANS}" font-size="12" fill="${C.muted}">Made with Claude Code</text>`,
  ]);
}

// ------------------------------------------------------------------ build --
function build() {
  const files = new Map();
  files.set('banner.svg', buildBanner());
  files.set('divider.svg', buildDivider());
  files.set('pulse.svg', buildPulse());
  files.set('made-with.svg', buildMadeWith());
  files.set('download.svg', buildDownload());
  for (const [name, def] of Object.entries(ICONS)) files.set(`${name}.svg`, buildIcon(def));
  return files;
}

const ASSET_NAMES = [
  'banner.svg',
  'divider.svg',
  'pulse.svg',
  'made-with.svg',
  'download.svg',
  ...Object.keys(ICONS).map(n => `${n}.svg`),
];

// Only these two move. Everything else is deliberately still, so the page has
// one focal animation at the top and one quiet rhythm between sections.
const ANIMATED = new Set(['banner.svg', 'divider.svg']);

module.exports = { build, PALETTE, ASSET_NAMES, ANIMATED };

if (require.main === module) {
  const files = build();
  for (const [name, content] of files) fs.writeFileSync(path.join(OUT_DIR, name), content);
  process.stdout.write(`${files.size} assets written to docs/assets/\n`);
}
