# Third-Party Notices

## claudex-route

This skill is adapted from the **claudex-route** skill of claudex-loop by Chase AI,
<https://github.com/chaseai-yt/claudex-loop>, at commit `8cf5e2c` (v2.1.0), used under the MIT License.

What changed in the adaptation (design: `docs/design/specs/2026-09-23-cross-review-design.md`, D12 and D13): the
handoff runs through `aos cross-review handoff` (read-only by default, an unsaved child session with the AgenticOS
hooks off, the `crossReview` budget and spend ledger) instead of a CLI command typed by the model; the candidate table
is dated and starts from the CLIs `preflight` reports; the loop it recommends is `/cross-review`.

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
