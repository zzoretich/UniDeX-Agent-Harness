# Third-Party Notices

## claudex-loop

This skill, `references/build.md` and the runner it calls (`brain/scripts/cross-review/runner.js`) are adapted from
**claudex-loop** by Chase AI, <https://github.com/chaseai-yt/claudex-loop>, at commit `8cf5e2c` (v2.1.0), used under
the MIT License.

What changed in the adaptation (design: `docs/design/specs/2026-09-23-cross-review-design.md`):

- The Python runner is rewritten in Node on the AgenticOS seams: binaries from the recorded host paths, argv from
  `lib/headless.js`, every child with the AgenticOS hooks switched off.
- Review rounds are fresh, unsaved sessions carrying the prior round's findings (`--prior`) instead of resumed
  sessions, so no reviewer transcript lands in the host's session folders.
- Each call is gated by `crossReview.perDayUsd` and recorded in the spend ledger as `cross-review:<mode>`.
- A user with one CLI can ask for a same-provider review, labelled `same-provider` everywhere.
- Recon consults the vault's memory (`recall`, `feedback_rules`) when those tools are available.
- The `codex-review` and `codex-build` aliases, the legacy skills and the Windows launch paths are not carried over.

```
MIT License

Copyright (c) 2026 Chase AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## grill-with-docs (CONTEXT-FORMAT.md, ADR-FORMAT.md)

`CONTEXT-FORMAT.md` and `ADR-FORMAT.md` are carried unchanged from claudex-loop, which adapted them from the
**grill-with-docs** skill by Matt Pocock, <https://github.com/mattpocock/skills>, used under the MIT License.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
