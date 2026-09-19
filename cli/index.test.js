'use strict';

// Tests for the svgunity CLI's argument handling and exit-code contract
// (mirroring the Rust CLI's semantics). Run with `npm test` (node --test)
// from this directory; the native addon must be present (dev checkout or
// npm install), since requiring index.js loads it.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const svgunity = require('./index.js');
const {
  UsageError,
  num,
  uint,
  boolArg,
  parseArgs,
  parsePixelCoord,
  windowFrameCount,
  pathKey,
  exitCodeOf,
} = svgunity.__internals;

const INDEX = path.join(__dirname, 'index.js');

// ── argument helpers ───────────────────────────────────────────────────────

test('num/uint validate ranges and integers', () => {
  assert.strictEqual(num('fps', '30'), 30);
  assert.throws(() => num('fps', 'abc'), UsageError);
  assert.throws(() => num('crf', '99', { min: 0, max: 51 }), UsageError);
  assert.strictEqual(uint('threads', '8'), 8);
  assert.throws(() => uint('fps', '1.5'), UsageError);
  assert.throws(() => uint('threads', '0', { min: 1 }), UsageError);
  assert.throws(() => uint('threads', '513', { max: 512 }), UsageError);
});

test('boolArg accepts true/false case-insensitively and rejects junk', () => {
  assert.strictEqual(boolArg('subtitle-bold', 'true'), true);
  assert.strictEqual(boolArg('subtitle-bold', 'False'), false);
  assert.throws(() => boolArg('subtitle-bold', 'nonsense'), UsageError);
});

test('parseArgs mirrors clap semantics', () => {
  const spec = {
    options: {
      out: { type: 'string', valueName: 'PATH' },
      rate: { type: 'string', valueName: 'PCT' },
      loudnorm: { type: 'string', valueName: 'LUFS', optional: true, defaultMissing: '-14' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    positional: { name: 'INPUT', min: 1, max: 1 },
  };
  // --opt value, a negative number as a value, a boolean flag, and the
  // `--` end-of-options marker (the next token becomes a positional even
  // when it looks like an option).
  const parsed = parseArgs(
    ['in.svg', '--out', 'o.mp4', '--rate', '-5', '--json', '--'],
    spec
  );
  assert.deepStrictEqual(parsed.positionals, ['in.svg']);
  assert.strictEqual(parsed.values.out, 'o.mp4');
  assert.strictEqual(parsed.values.rate, '-5');
  assert.strictEqual(parsed.values.json, true);

  assert.strictEqual(parseArgs(['in.svg', '--out=o.mp4'], spec).values.out, 'o.mp4');

  // An optional option with no value falls back to defaultMissing.
  assert.strictEqual(parseArgs(['in.svg', '--loudnorm'], spec).values.loudnorm, '-14');

  // `-h` maps onto the help flag.
  assert.strictEqual(parseArgs(['-h'], spec).values.help, true);

  // Usage errors: unknown option, inline value on a boolean flag, a missing
  // positional, and too many positionals.
  assert.throws(() => parseArgs(['in.svg', '--nope'], spec), UsageError);
  assert.throws(() => parseArgs(['in.svg', '--json=1'], spec), UsageError);
  assert.throws(() => parseArgs([], spec), UsageError);
  assert.throws(() => parseArgs(['a.svg', 'b.svg'], spec), UsageError);
});

test('parsePixelCoord validates "x,y"', () => {
  assert.strictEqual(parsePixelCoord('10,20'), '10,20');
  assert.strictEqual(parsePixelCoord(' 10 , 20 '), '10,20');
  assert.throws(() => parsePixelCoord('10'), UsageError);
  assert.throws(() => parsePixelCoord('a,5'), UsageError);
  assert.throws(() => parsePixelCoord('-1,5'), UsageError);
});

test('windowFrameCount mirrors render::window_frame_count', () => {
  // A static document (duration 0) samples a single frame at 1/fps.
  assert.strictEqual(windowFrameCount(0, 30, 0), 1);
  assert.strictEqual(windowFrameCount(2, 10, 0), 20);
  assert.strictEqual(windowFrameCount(2, 10, 0, 1), 10);
  assert.throws(() => windowFrameCount(2, 10, 3), UsageError); // end <= start
  assert.throws(() => windowFrameCount(2, 10, -1), UsageError);
  // A finite-but-enormous window passes the JS layer; the addon's
  // MAX_RENDER_FRAMES cap rejects it as a limit error (exit 1).
  assert.strictEqual(typeof windowFrameCount(1e9, 30, 0), 'number');
});

test('pathKey folds case on Windows and dot segments everywhere', () => {
  assert.strictEqual(pathKey('a/./b/../c.txt'), pathKey('a/c.txt'));
  assert.strictEqual(pathKey('./voice.webm'), pathKey('voice.webm'));
  if (process.platform === 'win32') {
    // NTFS is case-insensitive by default: the tts --word-boundaries
    // conflict check must treat these as the same file.
    assert.strictEqual(pathKey('C:\\Foo\\VOICE.webm'), pathKey('c:/foo/voice.webm'));
  }
});

test('exitCodeOf maps usage errors to 2 and everything else to 1', () => {
  assert.strictEqual(exitCodeOf(new UsageError('x')), 2);
  // The addon maps ErrorKind::InvalidInput to napi's InvalidArg status.
  assert.strictEqual(exitCodeOf({ code: 'InvalidArg' }), 2);
  // Node system errors (fs) and addon runtime failures stay at 1.
  assert.strictEqual(exitCodeOf({ code: 'ENOENT' }), 1);
  assert.strictEqual(exitCodeOf({ code: 'GenericFailure' }), 1);
  assert.strictEqual(exitCodeOf(new Error('x')), 1);
});

// ── end-to-end exit-code contract (subprocess) ────────────────────────────

test('CLI exit-code contract', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svgunity-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const svg = path.join(dir, 'tiny.svg');
  fs.writeFileSync(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2040e0"/></svg>'
  );

  const run = (...args) => spawnSync(process.execPath, [INDEX, ...args], { encoding: 'utf8' });

  // Usage errors exit 2 — JS-side validation and addon InvalidArg alike.
  assert.strictEqual(run('mp4', svg, '--crf', '99').status, 2);
  assert.strictEqual(run('mp4', svg, '--threads', '513').status, 2);
  assert.strictEqual(run('mp4', svg, '--subtitle-bold', 'nonsense').status, 2);
  assert.strictEqual(run('mp4', svg, '--encoder-preset', 'bogus').status, 2);
  assert.strictEqual(run('mp4', svg, '--backend', 'bogus').status, 2);
  assert.strictEqual(run('bogus-subcommand').status, 2);
  // Runtime failures exit 1.
  assert.strictEqual(run('mp4', path.join(dir, 'missing.svg')).status, 1);
  // A successful render exits 0 and produces the output file.
  const out = path.join(dir, 'ok.mp4');
  const ok = run('mp4', svg, '--out', out, '--threads', '2');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(out));
});
