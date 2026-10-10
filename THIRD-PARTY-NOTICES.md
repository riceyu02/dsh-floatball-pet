# Third-Party Notices

This file covers third-party components and assets distributed with
`dsh-floatball-pet`. The project license in `LICENSE` applies to the project's
original source code unless a section below says otherwise.

## Electron and Chromium

The packaged DSH plugin includes an unmodified Electron runtime. Electron is
licensed under the MIT License and contains Chromium and other third-party
software under their respective licenses.

- Electron project: <https://github.com/electron/electron>
- Electron license: <https://github.com/electron/electron/blob/main/LICENSE>

Every packaged runtime retains Electron's `LICENSE` file and Chromium's
`LICENSES.chromium.html` notice file next to the executable.

## koffi

The packaged application carries koffi and its prebuilt Windows x64 binary, used
for the in-process Win32 calls that keep the pet on top and let it step aside
for games (see `src/win32.js`). Both are distributed unmodified, as dev
dependencies of this project.

- `koffi` 3.3.1 — MIT License
- `@koromix/koffi-win32-x64` 3.3.1 — MIT License

- koffi project: <https://github.com/Koromix/koffi>
- koffi license: <https://github.com/Koromix/koffi/blob/master/LICENSE.txt>

## Artwork

The following artwork is supplied by the project maintainer. The maintainer
has confirmed that it may be publicly distributed and used as part of this
application. It is not licensed under the project's MIT License:

- `src/renderer/assets/avatar.png`

The reference sheet the ball artwork was drawn from is kept by the maintainer
outside this repository and is not distributed.

Permission covers redistribution with this application and its compiled plugin
packages. It does not grant permission to reuse the artwork separately or in
another product. Before publishing a fork with different artwork, document the
source and redistribution license that applies to your copy.

## DeepSeek Harness

DeepSeek Harness is developed by DeepSeek AI and is licensed separately. This
project is an independent third-party plugin and is not affiliated with,
endorsed by, or sponsored by DeepSeek AI.

- DeepSeek Harness: <https://github.com/deepseek-ai/deepseek-harness>
