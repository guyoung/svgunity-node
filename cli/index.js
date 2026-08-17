#!/usr/bin/env node
'use strict';

// svgunity — Node.js CLI for SVG animation rendering (frames/MP4), Edge TTS
// narration, subtitle generation and media checks, backed by the svgunity
// NAPI addon (the same Rust renderer pipeline as crates\svgunity-cli).
//
//   node index.js <COMMAND> [OPTIONS]
//
// The addon is loaded from (in order): the published optional dependency
// @svgunity/svgunity_lib.<triple>, the local per-platform package in
// svgunity-node/packages/<triple>, or the cargo cdylib in the workspace
// target dir. When required as a module, this file exports the addon.

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── addon loading ──────────────────────────────────────────────────────────

function tripleOf() {
  const osMap = { win32: 'win32', darwin: 'darwin', linux: 'linux' };
  const osName = osMap[process.platform];
  if (!osName) return null;
  const abi = osName === 'win32' ? '-msvc' : osName === 'linux' ? '-gnu' : '';
  return `${osName}-${process.arch}${abi}`;
}

function load() {
  const triple = tripleOf();
  if (triple) {
    // 1. Published optional dependency (npm install).
    try {
      // eslint-disable-next-line global-require
      return require(`@svgunity/svgunity_lib.${triple}`);
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }
    // 2. Local per-platform package (development checkout).
    const pkgIndex = path.join(__dirname, '..', 'packages', triple, 'index.js');
    if (fs.existsSync(pkgIndex)) {
      // eslint-disable-next-line global-require
      return require(pkgIndex);
    }
  }
  // 3. Cargo output in the workspace target dir (debug/release).
  const CANDIDATES = [
    path.join(__dirname, '..', '..', 'target', 'debug', 'svgunity_lib.node'),
    path.join(__dirname, '..', '..', 'target', 'release', 'svgunity_lib.node'),
  ];
  for (const file of CANDIDATES) {
    if (fs.existsSync(file)) {
      // eslint-disable-next-line global-require
      return require(file);
    }
  }
  const hint = path.join(__dirname, '..', '..', 'target');
  throw new Error(
    `svgunity addon not found. Run "npm run build" in ${__dirname} ` +
      `(or build the Rust crate into ${hint}) first.`
  );
}

const svgunity = load();

// ── small helpers ──────────────────────────────────────────────────────────

function defaultThreads() {
  try {
    return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  } catch {
    return 1;
  }
}

function num(name, value, { min, max } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new Error(
      `invalid value '${value}' for '--${name}': must be a number` +
        (min !== undefined ? ` >= ${min}` : '') +
        (max !== undefined ? ` <= ${max}` : '')
    );
  }
  return n;
}

function uint(name, value, { min = 1, max } = {}) {
  const n = num(name, value, { min, max });
  if (!Number.isInteger(n)) {
    throw new Error(`invalid value '${value}' for '--${name}': must be an integer`);
  }
  return n;
}

function extensionOfFormat(format) {
  if (format.startsWith('audio-')) return 'mp3';
  if (format.startsWith('ogg-')) return 'ogg';
  if (format.startsWith('riff-')) return 'wav';
  if (format.startsWith('webm-')) return 'webm';
  if (format.startsWith('raw-')) return 'raw';
  if (format.startsWith('amr-')) return 'amr';
  return null;
}

function readSvg(input) {
  if (!fs.existsSync(input)) throw new Error(`failed to read ${input}: no such file`);
  return fs.readFileSync(input, 'utf8');
}

function baseDirOf(input) {
  return path.dirname(path.resolve(input));
}

function fail(err) {
  console.error(`error: ${err.message || err}`);
  process.exit(1);
}

/// Frame count for a `[start, end)` window: `ceil((end - start) x fps)`, at
/// least 1 (mirrors render::window_frame_count in the Rust crate).
function windowFrameCount(duration, fps, start, end) {
  if (fps < 1) throw new Error('fps must be >= 1');
  if (!Number.isFinite(start) || start < 0) {
    throw new Error(`--start must be a finite value >= 0, got ${start}`);
  }
  let e;
  if (end !== undefined) {
    if (!Number.isFinite(end)) throw new Error(`--end must be a finite value, got ${end}`);
    e = end;
  } else if (duration > 0) {
    e = duration;
  } else {
    e = 1 / fps;
  }
  if (e <= start) {
    throw new Error(`--end (${e.toFixed(3)}) must be greater than --start (${start.toFixed(3)})`);
  }
  const framesF = (e - start) * fps;
  if (!Number.isFinite(framesF) || framesF >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`rendering window ${start}..${e} at ${fps} fps is too long`);
  }
  return Math.max(1, Math.ceil(framesF));
}

function parsePixelCoord(s) {
  const idx = s.indexOf(',');
  if (idx < 0) throw new Error(`--pixel expects "x,y", got "${s}"`);
  const x = Number(s.slice(0, idx).trim());
  const y = Number(s.slice(idx + 1).trim());
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw new Error(`--pixel expects "x,y" with non-negative integers, got "${s}"`);
  }
  return `${x},${y}`;
}

/// Recursively convert camelCase object keys to snake_case (matches the Rust
/// `--json` output of the check commands).
function toSnakeCase(obj) {
  if (Array.isArray(obj)) return obj.map(toSnakeCase);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = toSnakeCase(v);
    }
    return out;
  }
  return obj;
}

function printJson(obj) {
  console.log(JSON.stringify(toSnakeCase(obj), null, 2));
}

// ── tiny clap-like argument parser ─────────────────────────────────────────
// Mirrors the Rust CLI's clap semantics: `--opt value` / `--opt=value`, short
// flags, `--` end-of-options, negative numbers as option values, positionals.
// `optional: true` options (e.g. --loudnorm) accept a missing value and fall
// back to `defaultMissing`.

function isNegativeNumber(s) {
  return /^-?\d+(\.\d+)?$/.test(s);
}

function parseArgs(args, spec) {
  const values = {};
  const positionals = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let inline;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const opt = spec.options[name];
      if (!opt) throw new Error(`unexpected argument '--${name}' found`);
      if (opt.type === 'boolean') {
        if (inline !== undefined) {
          throw new Error(`unexpected value '${inline}' for '--${name}' found`);
        }
        values[name] = true;
      } else {
        let val = inline;
        if (val === undefined) {
          // Take the next token as the value only when it is not another
          // option (a leading `-` followed by digits is a negative number).
          const next = args[i + 1];
          if (next !== undefined && !(next.startsWith('-') && next.length > 1 && !isNegativeNumber(next))) {
            val = args[++i];
          }
        }
        if (val === undefined) {
          if (opt.optional) {
            val = opt.defaultMissing;
          } else {
            throw new Error(
              `a value is required for '--${name} <${opt.valueName ?? name}>' but none was supplied`
            );
          }
        }
        values[name] = val;
      }
    } else if (a.length > 1 && a[0] === '-') {
      const c = a.slice(1);
      const entry = Object.entries(spec.options).find(([, o]) => o.short === c);
      if (!entry) throw new Error(`unexpected argument '-${c}' found`);
      values[entry[0]] = true;
    } else {
      positionals.push(a);
    }
    i += 1;
  }
  if (!values.help && spec.positional && positionals.length < spec.positional.min) {
    throw new Error(
      `the following required arguments were not provided:\n  <${spec.positional.name}>`
    );
  }
  if (!values.help && spec.positional && positionals.length > spec.positional.max) {
    throw new Error(
      `unexpected argument '${positionals[spec.positional.max]}' found`
    );
  }
  return { values, positionals };
}

// ── subcommands ────────────────────────────────────────────────────────────

function cmdRender(args) {
  const spec = {
    options: {
      out: { type: 'string', valueName: 'DIR' },
      fps: { type: 'string', valueName: 'FPS' },
      duration: { type: 'string', valueName: 'SEC' },
      start: { type: 'string', valueName: 'SEC' },
      end: { type: 'string', valueName: 'SEC' },
      scale: { type: 'string', valueName: 'F' },
      threads: { type: 'string', valueName: 'N' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'INPUT', min: 1, max: 1 },
  };
  const { values, positionals } = parseArgs(args, spec);
  if (values.help) return printHelp('render');
  const input = positionals[0];
  const out = values.out ?? 'frames';
  const fps = uint('fps', values.fps ?? '30');
  const start = num('start', values.start ?? '0');
  const end = values.end !== undefined ? num('end', values.end) : undefined;
  const duration = values.duration !== undefined ? num('duration', values.duration) : undefined;
  const scale = num('scale', values.scale ?? '1.0');
  if (scale <= 0) throw new Error(`scale must be greater than 0, got ${scale}`);
  const threads = uint('threads', values.threads ?? String(defaultThreads()));

  const svg = readSvg(input);
  const baseDir = baseDirOf(input);
  const info = svgunity.svgInfo(svg, { baseDir });
  const [w, h] = svgunity.scaledSize(info.width, info.height, scale);
  const total = windowFrameCount(info.duration, fps, start, end);
  fs.mkdirSync(out, { recursive: true });

  const frames = svgunity.renderFrames(svg, {
    baseDir,
    fps,
    duration,
    start,
    ...(end !== undefined ? { end } : {}),
    scale,
    threads,
  });
  const progressEvery = Math.max(1, Math.floor(total / 20));
  for (let i = 0; i < total; i++) {
    const file = path.join(out, `frame_${String(i).padStart(5, '0')}.png`);
    fs.writeFileSync(file, frames[i]);
    if (i % progressEvery === 0) process.stderr.write(`\rrendering: ${i + 1}/${total}`);
  }
  process.stderr.write('\n');
  const endDisplay = end !== undefined ? end : info.duration > 0 ? info.duration : 1 / fps;
  console.log(
    `exported ${total} frames to ${out} (${w}x${h}, ${fps} fps, window ${start.toFixed(2)}s..${endDisplay.toFixed(2)}s, ${threads} threads)`
  );
}

function cmdMp4(args) {
  const spec = {
    options: {
      out: { type: 'string', valueName: 'PATH' },
      fps: { type: 'string', valueName: 'FPS' },
      duration: { type: 'string', valueName: 'SEC' },
      start: { type: 'string', valueName: 'SEC' },
      end: { type: 'string', valueName: 'SEC' },
      scale: { type: 'string', valueName: 'F' },
      threads: { type: 'string', valueName: 'N' },
      'video-codec': { type: 'string', valueName: 'CODEC' },
      crf: { type: 'string', valueName: 'N' },
      background: { type: 'string', valueName: '#RRGGBB' },
      subtitles: { type: 'string', valueName: 'FILE' },
      'subtitle-font': { type: 'string', valueName: 'FILE' },
      'subtitle-font-size': { type: 'string', valueName: 'F' },
      'subtitle-bold': { type: 'boolean' },
      'subtitle-margin-v': { type: 'string', valueName: 'F' },
      'subtitle-alignment': { type: 'string', valueName: 'N' },
      'subtitle-outline': { type: 'string', valueName: 'F' },
      'subtitle-font-name': { type: 'string', valueName: 'NAME' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'INPUT', min: 1, max: 1 },
  };
  const { values, positionals } = parseArgs(args, spec);
  if (values.help) return printHelp('mp4');
  const input = positionals[0];
  const out = values.out ?? input.replace(/\.[^/.]+$/, '') + '.mp4';
  const fps = uint('fps', values.fps ?? '30');
  const start = num('start', values.start ?? '0');
  const end = values.end !== undefined ? num('end', values.end) : undefined;
  const duration = values.duration !== undefined ? num('duration', values.duration) : undefined;
  const scale = num('scale', values.scale ?? '1.0');
  if (scale <= 0) throw new Error(`scale must be greater than 0, got ${scale}`);
  const threads = uint('threads', values.threads ?? String(defaultThreads()));
  const crf = uint('crf', values.crf ?? '10', { min: 0, max: 51 });
  const subtitleFontSize =
    values['subtitle-font-size'] !== undefined ? num('subtitle-font-size', values['subtitle-font-size']) : undefined;
  const subtitleBold = values['subtitle-bold'] !== undefined ? true : undefined;
  const subtitleMarginV =
    values['subtitle-margin-v'] !== undefined ? num('subtitle-margin-v', values['subtitle-margin-v']) : undefined;
  const subtitleAlignment =
    values['subtitle-alignment'] !== undefined ? uint('subtitle-alignment', values['subtitle-alignment'], { min: 1, max: 9 }) : undefined;
  const subtitleOutline =
    values['subtitle-outline'] !== undefined ? num('subtitle-outline', values['subtitle-outline']) : undefined;
  const subtitleFontName = values['subtitle-font-name'];

  const svg = readSvg(input);
  const baseDir = baseDirOf(input);
  const info = svgunity.svgInfo(svg, { baseDir });
  const [w, h] = svgunity.scaledSize(info.width, info.height, scale);
  const total = windowFrameCount(info.duration, fps, start, end);

  const codec = svgunity.renderMp4(svg, out, {
    baseDir,
    fps,
    duration,
    start,
    ...(end !== undefined ? { end } : {}),
    scale,
    threads,
    videoCodec: values['video-codec'] ?? 'libx264',
    crf,
    background: values.background ?? '#000000',
    ...(values.subtitles !== undefined ? { subtitle: values.subtitles } : {}),
    ...(values['subtitle-font'] !== undefined ? { subtitleFont: values['subtitle-font'] } : {}),
    ...(subtitleFontSize !== undefined ? { subtitleFontSize } : {}),
    ...(subtitleBold !== undefined ? { subtitleBold } : {}),
    ...(subtitleMarginV !== undefined ? { subtitleMarginV } : {}),
    ...(subtitleAlignment !== undefined ? { subtitleAlignment } : {}),
    ...(subtitleOutline !== undefined ? { subtitleOutline } : {}),
    ...(subtitleFontName !== undefined ? { subtitleFontName } : {}),
  });
  console.log(
    `generated ${out} (${w}x${h}, ${total} frames, ${fps} fps, duration ${(total / fps).toFixed(2)}s, codec ${codec}, ${threads} threads)`
  );
}

function cmdTts(args) {
  const spec = {
    options: {
      text: { type: 'string', valueName: 'TEXT' },
      input: { type: 'string', valueName: 'PATH' },
      out: { type: 'string', valueName: 'PATH' },
      voice: { type: 'string', valueName: 'VOICE' },
      rate: { type: 'string', valueName: 'PCT' },
      pitch: { type: 'string', valueName: 'HZ' },
      volume: { type: 'string', valueName: 'PCT' },
      format: { type: 'string', valueName: 'FMT' },
      'word-boundaries': { type: 'string', valueName: 'PATH' },
      'list-voices': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'none', min: 0, max: 0 },
  };
  const { values } = parseArgs(args, spec);
  if (values.help) return printHelp('tts');

  if (values['list-voices']) {
    const voices = svgunity.listVoices();
    console.log(
      `${'short_name'.padEnd(42)} ${'locale'.padEnd(12)} ${'friendly_name'.padEnd(30)}`
    );
    for (const v of voices) {
      const name = v.shortName ?? v.name;
      console.log(`${name.padEnd(42)} ${(v.locale ?? '').padEnd(12)} ${v.friendlyName ?? ''}`);
    }
    console.log(`\n${voices.length} voices in total.`);
    return;
  }

  if (values.text !== undefined && values.input !== undefined) {
    throw new Error("the argument '--text <TEXT>' cannot be used with '--input <PATH>'");
  }
  let text;
  if (values.text !== undefined) {
    text = values.text;
  } else if (values.input !== undefined) {
    text = fs.readFileSync(values.input, 'utf8');
  } else {
    throw new Error('the following required arguments were not provided:\n  --text <TEXT> or --input <PATH>');
  }
  const out = values.out ?? 'voice.webm';
  const voice = values.voice ?? 'zh-CN-XiaoxiaoNeural';
  const rate = values.rate !== undefined ? num('rate', values.rate) : 0;
  const pitch = values.pitch !== undefined ? num('pitch', values.pitch) : 0;
  const volume = values.volume !== undefined ? num('volume', values.volume) : 0;
  const format = values.format ?? 'webm-24khz-16bit-mono-opus';

  // Warn when --format and --out disagree (mirrors the Rust CLI).
  const expected = extensionOfFormat(format);
  if (expected) {
    const actual = path.extname(out).slice(1).toLowerCase();
    if (actual !== expected) {
      process.stderr.write(
        `warning: --format ${format} produces .${expected} audio but --out is ${JSON.stringify(out)}; ` +
          `the bytes are written verbatim\n`
      );
    }
  }
  const fmt = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}`;

  if (values['word-boundaries'] !== undefined) {
    const wb = path.resolve(values['word-boundaries']);
    if (wb === path.resolve(out)) {
      throw new Error('--word-boundaries and --out must be different paths');
    }
    const r = svgunity.ttsWithBoundaries(text, { voice, rate, pitch, volume, format });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, r.audio);
    // The measured audio duration goes into the boundary JSON (mirrors the
    // Rust CLI, which probes the written file).
    let durationSeconds;
    try {
      durationSeconds = svgunity.probeDuration(path.resolve(out));
    } catch (e) {
      process.stderr.write(`warning: ${e.message}\n`);
      durationSeconds = 0;
    }
    const json = {
      audio: out,
      voice,
      rate,
      pitch,
      volume,
      format,
      duration_seconds: durationSeconds,
      word_boundaries: r.wordBoundaries.map((w) => ({
        start_ms: w.startMs,
        end_ms: w.endMs,
        duration_ms: w.durationMs,
        text: w.text,
      })),
    };
    fs.mkdirSync(path.dirname(wb), { recursive: true });
    fs.writeFileSync(wb, JSON.stringify(json, null, 2));
    console.log(
      `written ${out} (${r.audio.length} bytes, voice=${voice}, rate=${fmt(rate)}%, pitch=${fmt(pitch)}Hz, volume=${fmt(volume)}%, word-boundaries -> ${wb})`
    );
    console.log(`duration ${durationSeconds.toFixed(2)}s`);
    return;
  }

  const audio = svgunity.tts(text, { voice, rate, pitch, volume, format });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, audio);
  console.log(
    `written ${out} (${audio.length} bytes, voice=${voice}, rate=${fmt(rate)}%, pitch=${fmt(pitch)}Hz, volume=${fmt(volume)}%)`
  );
  try {
    const seconds = svgunity.probeDuration(path.resolve(out));
    console.log(`duration ${seconds.toFixed(2)}s`);
  } catch (e) {
    process.stderr.write(`warning: ${e.message}\n`);
  }
}

function cmdMerge(args) {
  const spec = {
    options: {
      out: { type: 'string', valueName: 'PATH' },
      'video-codec': { type: 'string', valueName: 'CODEC' },
      'audio-codec': { type: 'string', valueName: 'CODEC' },
      pad: { type: 'string', valueName: 'SEC' },
      loudnorm: { type: 'string', valueName: 'LUFS', optional: true, defaultMissing: '-14' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'VIDEO AUDIO...', min: 2, max: Number.MAX_SAFE_INTEGER },
  };
  const { values, positionals } = parseArgs(args, spec);
  if (values.help) return printHelp('merge');
  const [video, ...audio] = positionals;
  const out = values.out ?? 'merged.mp4';
  const vcodec = values['video-codec'] ?? 'copy';
  const acodec = values['audio-codec'] ?? 'aac';
  const pad = values.pad !== undefined ? num('pad', values.pad) : undefined;
  const loudnorm = values.loudnorm !== undefined ? num('loudnorm', values.loudnorm) : undefined;

  svgunity.merge(video, audio, out, {
    videoCodec: vcodec,
    audioCodec: acodec,
    ...(pad !== undefined ? { pad } : {}),
    ...(loudnorm !== undefined ? { loudnorm } : {}),
  });
}

function cmdCompose(args) {
  const spec = {
    options: {
      out: { type: 'string', valueName: 'PATH' },
      'subtitle-font-size': { type: 'string', valueName: 'F' },
      'subtitle-bold': { type: 'boolean' },
      'subtitle-margin-v': { type: 'string', valueName: 'F' },
      'subtitle-alignment': { type: 'string', valueName: 'N' },
      'subtitle-outline': { type: 'string', valueName: 'F' },
      'subtitle-font-name': { type: 'string', valueName: 'NAME' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'MANIFEST', min: 1, max: 1 },
  };
  const { values, positionals } = parseArgs(args, spec);
  if (values.help) return printHelp('compose');
  const style = {};
  if (values['subtitle-font-size'] !== undefined) {
    style.fontSize = num('subtitle-font-size', values['subtitle-font-size']);
  }
  if (values['subtitle-bold'] !== undefined) style.bold = true;
  if (values['subtitle-margin-v'] !== undefined) {
    style.marginV = num('subtitle-margin-v', values['subtitle-margin-v']);
  }
  if (values['subtitle-alignment'] !== undefined) {
    style.alignment = uint('subtitle-alignment', values['subtitle-alignment'], { min: 1, max: 9 });
  }
  if (values['subtitle-outline'] !== undefined) {
    style.outline = num('subtitle-outline', values['subtitle-outline']);
  }
  if (values['subtitle-font-name'] !== undefined) style.fontName = values['subtitle-font-name'];
  const report = svgunity.compose(positionals[0], values.out, Object.keys(style).length ? style : undefined);
  if (values.json) {
    printJson(report);
  } else {
    console.log(
      `composed ${report.out} (${report.scenes} scenes, ${report.frames} frames, ${report.duration.toFixed(2)}s, ${report.fps.toFixed(2)} fps, codec ${report.codec}, ${report.threads} threads)`
    );
  }
}

function cmdSrt(args) {
  const spec = {
    options: {
      input: { type: 'string', valueName: 'PATH' },
      boundaries: { type: 'string', valueName: 'PATH' },
      out: { type: 'string', valueName: 'PATH' },
      'max-width-em': { type: 'string', valueName: 'F' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'none', min: 0, max: 0 },
  };
  const { values } = parseArgs(args, spec);
  if (values.help) return printHelp('srt');
  if (values.input === undefined && values.boundaries === undefined) {
    throw new Error('the following required arguments were not provided:\n  --input <PATH> and --boundaries <PATH>');
  }
  if (values.input === undefined) {
    throw new Error('the following required arguments were not provided:\n  --input <PATH>');
  }
  if (values.boundaries === undefined) {
    throw new Error('the following required arguments were not provided:\n  --boundaries <PATH>');
  }
  const text = fs.readFileSync(values.input, 'utf8');
  const boundariesJson = fs.readFileSync(values.boundaries, 'utf8');
  const out = values.out ?? values.input.replace(/\.[^/.]+$/, '') + '.srt';
  const maxWidthEm = values['max-width-em'] !== undefined ? num('max-width-em', values['max-width-em']) : undefined;
  const srt = svgunity.srtGenerate(text, boundariesJson, maxWidthEm);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, srt);
  const entries = srt.split('\r\n\r\n').filter(Boolean).length;
  console.log(`written ${out} (${entries} entries)`);
}

function cmdImageCheck(args) {
  const spec = {
    options: {
      pixel: { type: 'string', valueName: 'x,y' },
      background: { type: 'string', valueName: '#RRGGBB' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'INPUT', min: 1, max: 1 },
  };
  const { values, positionals } = parseArgs(args, spec);
  if (values.help) return printHelp('image-check');
  const pixel = values.pixel !== undefined ? parsePixelCoord(values.pixel) : undefined;
  const s = svgunity.imageStats(positionals[0], pixel, values.background);
  if (values.json) return printJson(s);
  console.log(`size ${s.width}x${s.height}`);
  console.log(`color_type ${s.colorType}`);
  console.log(`bytes ${s.bytes}`);
  console.log(`avg_rgba (${s.avgRgba.join(', ')})`);
  console.log(
    `unique_colors ${s.uniqueCapped ? `${s.uniqueColors}+` : s.uniqueColors}`
  );
  console.log(`translucent_pixels ${s.translucentPixels}`);
  if (s.uniform) {
    console.log(`uniform true rgba (${s.uniformColor.join(', ')})`);
  } else {
    console.log('uniform false');
  }
  if (s.queriedPixel) console.log(`pixel rgba (${s.queriedPixel.join(', ')})`);
  console.log(
    `content_bbox ${s.contentBbox ? s.contentBbox.join(',') : 'none'}`
  );
}

function cmdAudioCheck(args) {
  const spec = {
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'INPUT', min: 1, max: 1 },
  };
  const { values, positionals } = parseArgs(args, spec);
  if (values.help) return printHelp('audio-check');
  const s = svgunity.audioStats(positionals[0]);
  if (values.json) return printJson(s);
  console.log(`bytes ${s.bytes}`);
  console.log(`duration ${s.duration.toFixed(3)}s`);
  console.log(`sample_rate ${s.sampleRate}`);
  console.log(`channels ${s.channels}`);
  if (s.layout) console.log(`layout ${s.layout}`);
  console.log(`frames ${s.frames}`);
  console.log(`peak ${s.peak.toFixed(4)}`);
  console.log(`rms ${s.rms.toFixed(4)}`);
  console.log(`mean ${s.mean.toFixed(4)}`);
  if (s.peak < 0.01) {
    process.stderr.write(`warning: peak amplitude ${s.peak.toFixed(4)} is very low; the audio may be silent or empty\n`);
  }
}

function cmdVideoCheck(args) {
  const spec = {
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'INPUT', min: 1, max: 1 },
  };
  const { values, positionals } = parseArgs(args, spec);
  if (values.help) return printHelp('video-check');
  const s = svgunity.videoStats(positionals[0]);
  if (values.json) return printJson(s);
  console.log(`bytes ${s.bytes}`);
  console.log(`size ${s.width}x${s.height}`);
  console.log(`frames ${s.frames}`);
  console.log(`duration ${s.duration !== undefined && s.duration !== null ? `${s.duration.toFixed(3)}s` : 'unknown'}`);
  console.log(`fps ${s.fps !== undefined && s.fps !== null ? s.fps.toFixed(2) : 'unknown'}`);
  console.log(`mean_luma ${s.meanLuma.toFixed(1)}`);
  console.log(`min_mean_luma ${s.minMeanLuma.toFixed(1)}`);
  console.log(`max_mean_luma ${s.maxMeanLuma.toFixed(1)}`);
  console.log(`black_frames ${s.blackFrames}`);
  console.log(`white_frames ${s.whiteFrames}`);
  if (s.blackFrames > 0) {
    process.stderr.write(`warning: ${s.blackFrames} frame(s) are effectively black\n`);
  }
  if (s.whiteFrames > 0) {
    process.stderr.write(`warning: ${s.whiteFrames} frame(s) are effectively white\n`);
  }
}

// ── help ───────────────────────────────────────────────────────────────────

const COMMANDS = {
  render: {
    about: 'Render an SVG (incl. SMIL animation) to a PNG frame sequence',
    usage: 'node index.js render <INPUT> [OPTIONS]',
    args: [
      ['<INPUT>', 'Input SVG file'],
      ['--out <DIR>', 'Output directory [default: frames]'],
      ['--fps <FPS>', 'Frame rate (frames per second) [default: 30]'],
      ['--duration <SEC>', "Override the animation's total duration (seconds); defaults to the animation's own duration"],
      ['--start <SEC>', 'Start time (seconds) of the rendered window [default: 0]'],
      ['--end <SEC>', 'End time (seconds) of the rendered window; defaults to the animation duration'],
      ['--scale <F>', 'Resolution multiplier (1.0 = document intrinsic size) [default: 1.0]'],
      ['--threads <N>', 'Parallel render threads (default: logical CPU count)'],
      ['-h, --help', 'Print help'],
    ],
  },
  mp4: {
    about: 'Convert an SVG animation to an MP4 video',
    usage: 'node index.js mp4 <INPUT> [OPTIONS]',
    args: [
      ['<INPUT>', 'Input SVG file'],
      ['--out <PATH>', 'Output MP4 path (defaults to the input path with .mp4)'],
      ['--fps <FPS>', 'Frame rate (frames per second) [default: 30]'],
      ['--duration <SEC>', "Override the animation's total duration (seconds)"],
      ['--start <SEC>', 'Start time (seconds) of the rendered window [default: 0]'],
      ['--end <SEC>', 'End time (seconds) of the rendered window'],
      ['--scale <F>', 'Resolution multiplier [default: 1.0]'],
      ['--threads <N>', 'Parallel render threads (default: logical CPU count)'],
      ['--video-codec <CODEC>', 'Video codec (default libx264; falls back to mpeg4 if unavailable)'],
      ['--crf <N>', 'Quality 0-51: CRF for the x264 family (lower = sharper) [default: 10]'],
      ['--background <#RRGGBB>', 'Background color for transparent regions [default: #000000]'],
      ['--subtitles <FILE>', 'Burn subtitles from an .srt/.ass file (timed by the animation clock)'],
      ['--subtitle-font <FILE>', 'Font file for subtitle rendering (recommended for CJK)'],
      ['--subtitle-font-size <F>', 'Subtitle font size in pixels (default: scales with the shorter frame side)'],
      ['--subtitle-bold', 'Render subtitles in bold (default true)'],
      ['--subtitle-margin-v <F>', 'Subtitle bottom margin in pixels (default 10)'],
      ['--subtitle-alignment <N>', 'Subtitle alignment 1..9 (default 2 = bottom-center)'],
      ['--subtitle-outline <F>', 'Subtitle outline width in pixels (default 1.5)'],
      ['--subtitle-font-name <NAME>', 'Subtitle font family name (default follows --subtitle-font)'],
      ['-h, --help', 'Print help'],
    ],
  },
  tts: {
    about: 'Text to narration audio (Edge Read Aloud free service; WebM Opus by default)',
    usage: 'node index.js tts [OPTIONS]',
    args: [
      ['--text <TEXT>', 'Text to synthesize (mutually exclusive with --input)'],
      ['--input <PATH>', 'Read the text to synthesize from a file (mutually exclusive with --text)'],
      ['--out <PATH>', 'Output audio path [default: voice.webm]'],
      ['--voice <VOICE>', 'Voice [default: zh-CN-XiaoxiaoNeural] (see --list-voices)'],
      ['--rate <PCT>', 'Speech rate in percent (e.g. 10 = +10%) [default: 0]'],
      ['--pitch <HZ>', 'Pitch in Hz [default: 0]'],
      ['--volume <PCT>', 'Volume in percent [default: 0]'],
      ['--format <FMT>', 'Audio output format [default: webm-24khz-16bit-mono-opus]'],
      ['--word-boundaries <PATH>', 'Write the per-word boundary JSON (for precise subtitle timing)'],
      ['--list-voices', 'List the voices available on the server and exit'],
      ['-h, --help', 'Print help'],
    ],
  },
  merge: {
    about: 'Mux a video and one or more audio files into MP4',
    usage: 'node index.js merge <VIDEO> <AUDIO>... [OPTIONS]',
    args: [
      ['<VIDEO>', 'Video file (MP4 etc.)'],
      ['<AUDIO>...', 'One or more audio files (MP3/OGG/WEBM/WAV/AAC etc.), concatenated in order'],
      ['--out <PATH>', 'Output MP4 path [default: merged.mp4]'],
      ['--video-codec <CODEC>', 'Video stream handling: copy (default) or a codec name'],
      ['--audio-codec <CODEC>', 'Audio stream handling: aac (default, re-encoded) or copy'],
      ['--pad <SEC>', 'Multi-audio only: silence gap (seconds) between concatenated segments'],
      ['--loudnorm [LUFS]', 'Normalize audio loudness to this target (default -14); forces re-encoding'],
      ['-h, --help', 'Print help'],
    ],
  },
  compose: {
    about: 'Compose several SVG scenes into one MP4 with an audio-driven timeline',
    usage: 'node index.js compose <MANIFEST> [OPTIONS]',
    args: [
      ['<MANIFEST>', 'Manifest JSON (out/fps/scale/background/pad/video_codec/crf/threads + scenes[{svg, audio?, duration?}])'],
      ['--out <PATH>', "Override the manifest's output path"],
      ['--subtitle-font-size <F>', "Override the manifest's subtitle font size (px)"],
      ['--subtitle-bold', "Override the manifest's subtitle bold"],
      ['--subtitle-margin-v <F>', "Override the manifest's subtitle bottom margin (px)"],
      ['--subtitle-alignment <N>', "Override the manifest's subtitle alignment 1..9"],
      ['--subtitle-outline <F>', "Override the manifest's subtitle outline width (px)"],
      ['--subtitle-font-name <NAME>', "Override the manifest's subtitle font family name"],
      ['--json', 'Print the final video/audio durations as JSON instead of a summary'],
      ['-h, --help', 'Print help'],
    ],
  },
  srt: {
    about: 'Generate SRT subtitles from narration text and the word-boundary JSON',
    usage: 'node index.js srt --input <PATH> --boundaries <PATH> [OPTIONS]',
    args: [
      ['--input <PATH>', 'Narration text file'],
      ['--boundaries <PATH>', 'Word-boundary JSON from `tts --word-boundaries`'],
      ['--out <PATH>', 'Output SRT path (defaults to the input path with .srt)'],
      ['--max-width-em <F>', 'Max subtitle line width in em (default 16 ≈ 15 chars at 1080-wide / 64px)'],
      ['-h, --help', 'Print help'],
    ],
  },
  'image-check': {
    about: "Inspect an image's pixels: dimensions, color stats, specific pixels",
    usage: 'node index.js image-check <INPUT> [OPTIONS]',
    args: [
      ['<INPUT>', 'Input image file (PNG/JPEG/WebP/GIF/BMP/TIFF/TGA/ICO/PNM/QOI)'],
      ['--pixel <x,y>', 'Report the RGBA value of one pixel'],
      ['--background <#RRGGBB>', 'Report the bounding box of the pixels different from this color'],
      ['--json', 'Print the stats as a JSON object'],
      ['-h, --help', 'Print help'],
    ],
  },
  'audio-check': {
    about: 'Decode an audio file and report its duration, rate and loudness',
    usage: 'node index.js audio-check <INPUT> [OPTIONS]',
    args: [
      ['<INPUT>', 'Input audio file (MP3/OGG/WAV/AAC/WebM/...)'],
      ['--json', 'Print the stats as a JSON object'],
      ['-h, --help', 'Print help'],
    ],
  },
  'video-check': {
    about: 'Decode a video file and report its dimensions, timing and frame stats',
    usage: 'node index.js video-check <INPUT> [OPTIONS]',
    args: [
      ['<INPUT>', 'Input video file (MP4/WebM/...)'],
      ['--json', 'Print the stats as a JSON object'],
      ['-h, --help', 'Print help'],
    ],
  },
};

function printHelp(cmd) {
  if (cmd) {
    const c = COMMANDS[cmd];
    console.log(`${c.about}\n\nUsage: ${c.usage}\n\nOptions:\n`);
    const width = Math.max(...c.args.map(([n]) => n.length));
    for (const [name, desc] of c.args) {
      console.log(`  ${name.padEnd(width)}  ${desc}`);
    }
    return;
  }
  console.log(
    `SVG animation rendering (frames/MP4), Edge TTS narration, subtitles and media checks\n\n` +
      `Usage: node index.js <COMMAND> [OPTIONS]\n\nCommands:\n`
  );
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(width)}  ${c.about}`);
  }
  console.log(`\nOptions:\n  -h, --help     Print help\n  -V, --version  Print version`);
}

// ── entry ──────────────────────────────────────────────────────────────────

function main(argv) {
  if (argv.length === 0) {
    printHelp();
    return;
  }
  if (argv[0] === '-h' || argv[0] === '--help') return printHelp();
  if (argv[0] === '-V' || argv[0] === '--version') {
    console.log(`svgunity ${require('./package.json').version}`);
    return;
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'render':
      return cmdRender(rest);
    case 'mp4':
      return cmdMp4(rest);
    case 'tts':
      return cmdTts(rest);
    case 'merge':
      return cmdMerge(rest);
    case 'compose':
      return cmdCompose(rest);
    case 'srt':
      return cmdSrt(rest);
    case 'image-check':
      return cmdImageCheck(rest);
    case 'audio-check':
      return cmdAudioCheck(rest);
    case 'video-check':
      return cmdVideoCheck(rest);
    default:
      throw new Error(`unrecognized subcommand '${cmd}'`);
  }
}

module.exports = svgunity;

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    fail(e);
  }
}
