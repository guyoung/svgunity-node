# svgunity-node

The Node.js side of svgunity: exposes the `svgunity-renderer` (SVG rendering
pipeline: SMIL animation, CSS, filters, text shaping) and `svgunity-cli`
(rendering / Edge TTS narration / muxing / subtitles / checks) to JavaScript
through a NAPI binding.

Two parts:

- **`cli/`** — the Node.js command-line tool (`node index.js <COMMAND>`), whose
  subcommands mirror the Rust CLI (`crates\svgunity-cli`);
- **`packages/`** — per-platform prebuilt native addon packages (NAPI-RS
  artifacts); the same pipeline can also be `require`d directly as a JS API.

## Layout

```
svgunity-node/
├── cli/
│   ├── index.js           # CLI entry (also exports the addon when required as a module)
│   ├── package.json       # bin: svgunity = index.js; optionalDependencies point to the platform packages
│   └── README.md          # Detailed CLI usage
└── packages/
    ├── index.js           # NAPI-RS generated loader (with platform detection)
    ├── index.d.ts         # Auto-generated TypeScript definitions
    └── <triple>/          # Per-platform package, e.g. win32-x64-msvc / darwin-arm64 …
        ├── index.js       # module.exports = require('./svgunity_lib.<triple>.node')
        ├── package.json   # @svgunity/svgunity_lib.<triple>
        └── svgunity_lib.<triple>.node   # Native binary (gitignored; built by CI or locally)
```

## Requirements

- **Node.js** (verified with v24; the CLI is synchronous and CPU-bound)
- **Native binding**, obtained by any of:
  1. `npm install` in `cli/`, pulling the published
     `@svgunity/svgunity_lib.<triple>` binary from optionalDependencies;
  2. the development checkout's own
     `packages/<triple>/svgunity_lib.<triple>.node`;
  3. building from source (see "Building from source" below), producing
     `prebuilds/` or the workspace `target\{debug,release}\`.

The FFmpeg capability used by rendering / TTS / muxing is statically linked
into the native binding — no separate installation needed.

## Quick start (CLI)

Without a global install, run with `node`; after `npm i -g .` (or
`npm link`) in `cli/`, use `svgunity` directly — both are equivalent:

```bat
node svgunity-node\cli\index.js <COMMAND> [OPTIONS]
svgunity <COMMAND> [OPTIONS]
```

When the package is installed as a project dependency, `npx svgunity
<COMMAND>` also resolves the local binary (see `cli/README.md`).

Command overview (see `cli/README.md` and each command's `--help`):

| Command | Purpose |
|---|---|
| `render` | Render an SVG (incl. SMIL animation) into a PNG frame sequence |
| `mp4` | Convert an SVG animation to an MP4 video |
| `tts` | Synthesize text into narration audio (Edge Read Aloud, free, no API key); `--word-boundaries` exports per-word timestamps |
| `merge` | Mux a video with one or more audio files (concatenated in order); `--loudnorm` loudness normalization |
| `compose` | Compose several SVG scenes + narration into one MP4 (audio-driven timeline, subtitle burn-in) |
| `srt` | Generate SRT subtitles from narration text + per-word timestamp JSON |
| `image-check` / `audio-check` / `video-check` | Image / audio / video checks (all support `--json`) |

Typical workflow (a narrated explainer video):

```bat
svgunity tts --input narration_01.txt --voice zh-CN-XiaoxiaoNeural --out narration_01.webm --word-boundaries narration_01.boundaries.json
svgunity srt --input narration_01.txt --boundaries narration_01.boundaries.json --out subtitles\page01.srt
svgunity compose video.json --json
```

## Using the JS API

`cli/index.js` exports the addon when required as a module, so the same
pipeline is callable from JS:

```js
const svgunity = require('./svgunity-node/cli');

// Rendering
const info = svgunity.svgInfo(svgString, { baseDir });
const png = svgunity.renderFrame(svgString, 1.0, { fps: 30, scale: 1 });
svgunity.renderMp4(svgString, 'out.mp4', { fps: 30, threads: 8, subtitle: 'sub.srt', subtitleFont: 'msyh.ttc' });

// Narration + subtitles
const { audio, wordBoundaries } = svgunity.ttsWithBoundaries(text, { voice: 'zh-CN-XiaoxiaoNeural' });
const srt = svgunity.srtGenerate(text, boundariesJson);

// Compose / checks
const report = svgunity.compose(manifestPath);
const video = svgunity.videoStats('out.mp4');
const audioStats = svgunity.audioStats('narration.webm');
```

Full function signatures and options live in the auto-generated
`packages/index.d.ts`: `svgInfo`, `scaledSize`, `renderFrame`, `renderFrames`,
`renderMp4`, `tts`, `ttsWithBoundaries`, `listVoices`, `merge`, `compose`,
`srtGenerate`, `probeDuration`, `imageStats`, `audioStats`, `videoStats`.

## Native binding loading

`cli/index.js` loads the addon in this order:

1. The installed optional dependency `@svgunity/svgunity_lib.<triple>`
   (`npm install`);
2. The local platform package `packages/<triple>/index.js`;
3. The Cargo artifact `target\{debug,release}\svgunity_lib.node` in the
   workspace.

A clear error is thrown (with build/install hints) when none is found. The
`triple` is derived from `process.platform` / `process.arch` (e.g.
`win32-x64-msvc`).

## Building from source

Prerequisites: the Rust toolchain (MSVC) with the VS2022 C++ toolchain, a
statically linked FFmpeg (see `crates/svgunity-cli/README.zh-CN.md`), and a
working `@napi-rs/cli`.

From the `cli/` directory (needs a package.json):

```bat
npx --yes -p @napi-rs/cli napi build --release ^
  --manifest-path ..\..\crates\svgunity-cli\Cargo.toml ^
  --output-dir prebuilds
```

The output is `prebuilds\svgunity_lib.node`; the platform packages under
`packages/` are produced by the CI workflow
`.github/workflows/build-svgunity-lib.yml` or a local `napi build --platform`.
`*.node` binaries stay out of git (`.gitignore`); the scaffold files
(`package.json` / `index.js` / `index.d.ts` / `README.md`) are tracked.

## License

MIT
