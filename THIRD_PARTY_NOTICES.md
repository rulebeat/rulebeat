# Third-party notices

RuleBeat is licensed under Apache-2.0 (see [`LICENSE`](LICENSE) and
[`LICENSE_SCOPE.md`](LICENSE_SCOPE.md)). This file lists content bundled with RuleBeat that carries
its own, separate license: a vendored rule pack, self-hosted fonts, and a summary of the npm
dependency tree's licenses.

## Azure Proactive Resiliency Library v2 (APRL)

- **What:** 143 built-in rules under `packages/web/data/packs/aprl-v2.json`, synced from
  `https://github.com/Azure/Azure-Proactive-Resiliency-Library-v2`, pinned commit
  `1824eb5958d11482f6e23c231f0cb1d2d5bd44f6`.
- **License:** MIT
- **Copyright:** (c) Microsoft Corporation.

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Fonts

Self-hosted at build time via `next/font/google`; see `packages/web/app/layout.tsx`.

- **Inter**: SIL Open Font License, Version 1.1. Copyright the Inter Project Authors.
- **Inter Tight**: SIL Open Font License, Version 1.1. Copyright the Inter Project Authors.
- **IBM Plex Mono**: SIL Open Font License, Version 1.1. Copyright IBM Corp.

Full OFL 1.1 text: https://openfontlicense.org/open-font-license-official-text/

## npm dependencies

An SPDX audit of the full hoisted dependency tree (`npx license-checker --summary`, from the repo
root, 802 packages as of 2026-08-17) found:

```
MIT: 669  ·  ISC: 47  ·  Apache-2.0: 32  ·  BSD-3-Clause: 14  ·  BSD-2-Clause: 12
BlueOak-1.0.0: 9  ·  MPL-2.0: 6  ·  0BSD: 2  ·  Python-2.0: 1  ·  CC-BY-4.0: 1
CC0-1.0: 1  ·  MIT-0: 1  ·  MIT AND ISC: 1  ·  (MIT OR WTFPL): 1
(MIT OR CC0-1.0): 1  ·  (BSD-2-Clause OR MIT OR Apache-2.0): 1
Apache-2.0 AND LGPL-3.0-or-later: 1
```

**No GPL/AGPL/SSPL-family (strong copyleft) package found.** One entry worth a specific note:
**`Apache-2.0 AND LGPL-3.0-or-later`: `@img/sharp-win32-x64`**, the platform binary for `sharp`
(image processing, used by Next.js's image optimization). `sharp`'s LGPL obligation attaches to its
bundled `libvips` component; used as an ordinary npm dependency (not statically linked into a
distributed binary in a way that would trigger relicensing), this is the routine, low-risk case LGPL
is designed for, but it's the one non-fully-permissive license in the tree and worth a one-line
mention here rather than silence.

RuleBeat's own three workspace packages (`rulebeat`, `@rulebeat/core`, `@rulebeat/web`) each declare
`"license": "Apache-2.0"` in their `package.json`, matching [`LICENSE`](LICENSE).
