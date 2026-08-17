# svgunity

Node.js CLI for SVG animation rendering (frame export / MP4) and Edge TTS
narration, backed by the `svgunity` NAPI addon (the same Rust renderer
pipeline: SMIL animation, CSS, filters, text shaping).

Input/output options mirror the Rust CLI (`svgunity-cli`); note the
`--duration` difference (see the render section below).

## Usage

Run with `node index.js <COMMAND>` from this directory. Once the package is
installed as a project dependency (`npm install`), use `npx svgunity-cli
<COMMAND>`; after a global install (`npm i -g .` / `npm link`), plain
`svgunity-cli <COMMAND>` also works. The subcommands mirror the Rust CLI
(`crates\svgunity-cli`):

```bat
node index.js render <INPUT> [--out DIR] [--fps N] [--duration SEC] [--start SEC] [--end SEC] [--scale F] [--threads N]
node index.js mp4    <INPUT> [--out PATH] [--fps N] [--duration SEC] [--start SEC] [--end SEC] [--scale F] [--threads N]
                       [--video-codec CODEC] [--crf N] [--background #RRGGBB] [--subtitles FILE] [--subtitle-font FILE]
                       [--subtitle-font-size F] [--subtitle-bold] [--subtitle-margin-v F] [--subtitle-alignment N] [--subtitle-outline F] [--subtitle-font-name NAME]
node index.js tts    [--text TEXT | --input PATH] [--out PATH] [--voice VOICE]
                [--rate PCT] [--pitch HZ] [--volume PCT] [--format FMT] [--word-boundaries PATH] [--list-voices]
node index.js merge  <VIDEO> <AUDIO>... [--out PATH] [--video-codec CODEC] [--audio-codec CODEC] [--pad SEC] [--loudnorm]
node index.js compose <MANIFEST> [--out PATH] [--subtitle-font-size F] [--subtitle-bold] [--subtitle-margin-v F] [--subtitle-alignment N] [--subtitle-outline F] [--subtitle-font-name NAME] [--json]
node index.js srt    --input <PATH> --boundaries <PATH> [--out PATH] [--max-width-em F]
node index.js image-check <INPUT> [--pixel x,y] [--background #RRGGBB] [--json]
node index.js audio-check <INPUT> [--json]
node index.js video-check <INPUT> [--json]
```

### npx / global install

After `npm install` in a project that depends on this package, `npx svgunity-cli`
resolves the local binary — no global install needed:

```bat
npx svgunity-cli tts --input script.txt --out narration.webm
npx svgunity-cli render intro.svg --out frames --fps 30
npx svgunity-cli compose video.json --json
```

`npm i -g .` (or `npm link`) run in this directory additionally exposes the
global `svgunity-cli` command in any directory.

### render

Render an SVG (including SMIL animation) into a PNG frame sequence
(`frame_00000.png`, `frame_00001.png`, …):

```bat
node index.js render intro.svg --out frames --fps 30 --scale 2
node index.js render intro.svg --end 10 --threads 8
```

Note: `--duration` overrides the animation's total sampling duration but does
*not* drive the rendered window — use `--start` / `--end` to control the
window (e.g. `--end 10` renders the first 10 seconds).

### mp4

Convert an SVG animation to an MP4 video (H.264 by default; falls back to
`mpeg4` when `libx264` is unavailable):

```bat
node index.js mp4 intro.svg
node index.js mp4 intro.svg --out out.mp4 --fps 60 --crf 18
node index.js mp4 intro.svg --video-codec mpeg4 --crf 4 --background "#ffffff"
```

### tts

Synthesize text to an audio file (WebM/Opus by default) using Microsoft Edge's
free "Read Aloud" service; after synthesis the measured duration is printed:

```bat
node index.js tts --text "Hello, this is the narration." --voice en-US-JennyNeural --out voice.webm
node index.js tts --input script.txt --voice zh-CN-YunxiNeural --rate 10
node index.js tts --list-voices
```

### merge

Mux a video and one or more audio files (concatenated in order) into a single
MP4:

```bat
node index.js merge intro.mp4 narration.webm --out intro_with_voice.mp4
node index.js merge intro.mp4 narration_01.webm narration_02.webm --out intro_full.mp4 --pad 0.4
```

## Typical workflow

```bat
node index.js mp4 intro.svg --out intro.mp4
node index.js tts --input script.txt --out narration.webm
node index.js merge intro.mp4 narration.webm --out intro_final.mp4
```

## Notes

- All functions are synchronous and CPU-bound (like the CLI).
- The addon can also be used directly from JS via `require('./index.js')`
  (or `require('.')` from this directory; see `crates/svgunity-cli/src/napi.rs`):
  `svgInfo`, `renderFrame`, `renderFrames`, `renderMp4`, `tts`,
  `ttsWithBoundaries`, `listVoices`, `merge`, `compose`, `srtGenerate`,
  `probeDuration`, `scaledSize`, `imageStats`, `audioStats`, `videoStats`.
