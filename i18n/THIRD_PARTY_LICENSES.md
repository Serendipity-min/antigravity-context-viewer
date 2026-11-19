# Third-Party Licenses & Acknowledgements

This fork is licensed under the MIT License (see root `LICENSE`) and incorporates or draws architectural inspiration from the following open-source projects:

## 1. Upstream Base: antigravity-context-viewer
- Repository: https://github.com/elviscjn-cjn/antigravity-context-viewer
- License: MIT License (Copyright (c) 2026 Antigravity Context Viewer Contributors)

## 2. Chinese Localization Dictionary (v2.33.0+): Antigravity-Chinese-Localization
- Repository: https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization
- Usage: `i18n/zh-CN.v233.json` (`exact` and `coreWords` dictionaries) and v2.33.0 DOM exclusion patterns.
- License:

```text
MIT License

Copyright (c) 2026 aabbWei
Copyright (c) 2026 antigravity-cn-community contributors

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

## 3. Context Token Breakdown Architecture: antigravity-desktop-context
- Repository: https://github.com/dimitr-io/antigravity-desktop-context
- License: MIT License (Copyright (c) 2026 Dimitrios Ioannidis)
- Usage: `TokenType` protobuf category mapping and opened-file extraction concepts adapted into pure Node.js in `meter-context-breakdown.js`.

## 4. Transient Error Auto-Retry Concept: antigravity-auto-retry
- Repository: https://github.com/KingYeon-Zoo/antigravity-auto-retry
- License: MIT License

## 5. Headless Sidecar Keeper Architecture Reference: antigravity-themes
- Repository: https://github.com/materialwebunofficial/antigravity-themes
- License: Apache-2.0 License (Copyright 2026 The antigravity-themes contributors)
- Usage: Architectural reference for official Antigravity headless `sidecars/keeper/sidecar.json` (`restart_policy: "never"`) update-survival pattern; all keeper code in this repository is independently implemented.
