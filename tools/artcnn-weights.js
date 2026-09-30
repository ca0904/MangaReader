'use strict';
// Pulls the weights out of ArtCNN_C4F32.glsl (https://github.com/Artoriuz/ArtCNN, MIT,
// Copyright (c) 2024 Joao Chrisostomo, Kacper Michajłow) into public/artcnn-c4f32.bin.
//
//   node tools/artcnn-weights.js path/to/ArtCNN_C4F32.glsl
//
// The shader spells every weight out as a GLSL constant, one pass per layer. Parsing it
// once here keeps 760 KB of GLSL out of the browser. The .bin holds, for each of the
// seven convolutions in order, the weights as [out][in][ky][kx] and then the biases, all
// float32 little-endian. public/artcnn.js knows the shapes; this checks them.
const fs = require('fs');
const path = require('path');

const NUM = /[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g;

// in channels, out channels, ReLU, adds the first layer's output back in
const EXPECT = [
  [1, 32, false, false],
  [32, 32, true, false], [32, 32, true, false], [32, 32, true, false], [32, 32, true, false],
  [32, 32, false, false],
  [32, 4, false, true]
];

const src = fs.readFileSync(process.argv[2] || die('usage: node tools/artcnn-weights.js ArtCNN_C4F32.glsl'), 'utf8');
const passes = src.split('//!DESC ').slice(1).filter(p => !p.startsWith('ArtCNN C4F32 (Depth-To-Space)'));
if (passes.length !== EXPECT.length) die(`expected ${EXPECT.length} convolutions, found ${passes.length}`);

const out = [];
passes.forEach((p, n) => {
  const [inC, outC, relu, skip] = EXPECT[n];
  const bias = new Float32Array(outC);
  for (const m of p.matchAll(/V4 result(\d+) = V4\(([^)]*)\);/g)) {
    m[2].match(NUM).forEach((v, i) => { bias[4 * Number(m[1]) + i] = Number(v); });
  }
  const w = new Float32Array(outC * inC * 9);
  let terms = 0;
  for (const m of p.matchAll(/result(\d+) \+= (M4|V4)\(([^)]*)\) \* inp_(\d+)_(\d)_(\d);/g)) {
    const [k, kind, g, kx, ky] = [Number(m[1]), m[2], Number(m[4]), Number(m[5]), Number(m[6])];
    const v = m[3].match(NUM).map(Number);
    const at = (o, i) => ((o * inC + i) * 3 + ky) * 3 + kx;
    if (kind === 'V4') {
      for (let i = 0; i < 4; i++) w[at(4 * k + i, 0)] = v[i];
    } else {
      // GLSL matrices are column-major: M * v sums column j times v[j], and column j is
      // v[4j .. 4j+3], so the weight from input j to output i is v[4j + i].
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) w[at(4 * k + i, 4 * g + j)] = v[4 * j + i];
    }
    terms++;
  }
  const sawRelu = p.includes('max(result0, V4(0.0))');
  const sawSkip = p.includes('conv2d_5_raw') && p.includes('conv2d_raw');
  if (terms !== (outC / 4) * (inC === 1 ? 1 : inC / 4) * 9 || sawRelu !== relu || sawSkip !== skip) {
    die(`convolution ${n} is not shaped as expected (${terms} terms, relu ${sawRelu}, skip ${sawSkip})`);
  }
  out.push(w, bias);
});

const bytes = Buffer.concat(out.map(a => Buffer.from(a.buffer)));
const dest = path.join(__dirname, '..', 'public', 'artcnn-c4f32.bin');
fs.writeFileSync(dest, bytes);
console.log(`wrote ${dest}: ${bytes.length / 4} weights`);

function die(msg) { console.error(msg); process.exit(1); }
