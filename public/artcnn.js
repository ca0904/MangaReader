'use strict';

// ArtCNN C4F32 on WebGPU: a small convolutional network that doubles anime-style line art
// (https://github.com/Artoriuz/ArtCNN, MIT, Copyright (c) 2024 Joao Chrisostomo,
// Kacper Michajłow). The weights come from its mpv shader; see tools/artcnn-weights.js.
//
// Measured on this collection against lanczos.js, at the sizes it is actually read at,
// it kept more of the original on every page tried: about +4 dB on manhwa strips at
// 1.65-2.13x and +1.6 to +2.4 dB on manga pages at 1.1-1.5x.
//
// The network only works on luma and only at exactly 2x, so a page goes:
//   RGB -> luma -> seven 3x3 convolutions -> 2x luma
//   2x luma, shrunk (or grown) to the target with Lanczos, whose support is widened by the
//   inverse ratio when shrinking so it does not alias; the benchmark lost most of the
//   gain when this step was plain bilinear
//   + chroma, taken straight from the source with Lanczos -> RGB
//
// The convolutions run in horizontal bands. Every layer holds 32 channels per pixel, so a
// whole 690x8000 page would need about 700 MB per layer; a band of 128 rows needs 12 MB.
// Seven stacked 3x3 layers see 7 pixels in every direction, so each band carries 7 rows
// of overlap above and below and only its middle rows are kept.
//
// Each band is its own GPU submission, sent only once the GPU has finished the last. Sent
// as one ~150 ms block, a page kept Safari from drawing scroll frames meanwhile and
// scrolling stuttered: its worst frame gap was 45-109 ms, and with 128-row bands 18 ms,
// no worse than with nothing rendering, for about 20 ms more per page. Pages also render
// one at a time, in the order asked for, and a page no longer wanted is dropped.
const ArtCNN = (() => {
  // in channels, out channels, ReLU, adds the first layer's output back in
  const LAYERS = [
    [1, 32, false, false],
    [32, 32, true, false], [32, 32, true, false], [32, 32, true, false], [32, 32, true, false],
    [32, 32, false, false],
    [32, 4, false, true]
  ];
  const HALO = LAYERS.length;
  const BAND = 128;
  const MAX_SIDE = 8192;    // the same ceiling lanczos.js has, so the two cover the same pages

  let device = null, layers = null, lumaPipe = null, ok = false, maxBuffer = 0;
  let queue = Promise.resolve();     // pages waiting their turn on the GPU
  const finalPipes = new Map();    // one per output texture format

  // Each invocation computes PX neighbouring pixels, so every weight it reads is used PX
  // times. The shader is generated fully unrolled, as the mpv one is: written as loops over
  // arrays, the accumulators were not kept in registers and the network ran at a sixth of
  // the speed. Two pixels measured fastest on an M2; at three or more the registers run
  // out and it slows down again.
  const PX = 2;

  // Weights are stored as [in][ky][kx][out/4] vec4s, biases after, so one read feeds four
  // output channels.
  function convShader(inC, outC, relu, skip, first) {
    const O4 = outC / 4, N = inC * 9 * O4;
    const read = (row, col) => {
      const i = first ? `(p.a + ${row}) * p.W + ${col}` : `(ic * p.B + ${row}) * p.W + ${col}`;
      return skip ? `src[${i}] + skipped[${i}]` : `src[${i}]`;
    };
    const lines = [];

    // The input neighbourhood, 3 rows by PX + 2 columns, with zeros off the band's edges:
    // the network was trained with zero padding.
    for (let c = 0; c < PX + 2; c++) lines.push(`  let c${c} = x0 + ${c - 1} >= 0 && x0 + ${c - 1} < i32(p.W);`);
    lines.push('  let r0 = y > 0;', '  let r1 = true;', '  let r2 = y + 1 < i32(p.B);');
    for (let q = 0; q < PX; q++) {
      for (let o = 0; o < O4; o++) lines.push(`  var a${q}_${o} = w[${N + o}u];`);
    }
    lines.push(`  for (var ic = 0u; ic < ${inC}u; ic++) {`, `    let base = ic * ${9 * O4}u;`);
    for (let ky = 0; ky < 3; ky++) {
      for (let c = 0; c < PX + 2; c++) {
        lines.push(`    let i${ky}_${c} = select(0.0, ${read(`u32(y + ${ky - 1})`, `u32(x0 + ${c - 1})`)}, r${ky} && c${c});`);
      }
    }
    for (let ky = 0; ky < 3; ky++) {
      for (let kx = 0; kx < 3; kx++) {
        for (let o = 0; o < O4; o++) {
          lines.push(`    { let wv = w[base + ${(ky * 3 + kx) * O4 + o}u];`);
          for (let q = 0; q < PX; q++) lines.push(`      a${q}_${o} += wv * i${ky}_${q + kx};`);
          lines.push('    }');
        }
      }
    }
    lines.push('  }');

    for (let q = 0; q < PX; q++) {
      lines.push(`  if (x0 + ${q} < i32(p.W)) {`, `    let x = u32(x0 + ${q});`);
      if (outC === 4) {
        // The last layer's four channels are the four pixels of a 2x2 block (depth to space).
        lines.push(`    let v = clamp(a${q}_0, vec4f(0.0), vec4f(1.0));`,
                   '    let W2 = 2u * p.W;',
                   '    let r = 2u * (p.a + u32(y));',
                   '    dst[r * W2 + 2u * x] = v.x;',
                   '    dst[r * W2 + 2u * x + 1u] = v.y;',
                   '    dst[(r + 1u) * W2 + 2u * x] = v.z;',
                   '    dst[(r + 1u) * W2 + 2u * x + 1u] = v.w;');
      } else {
        for (let o = 0; o < O4; o++) {
          lines.push(`    let v${o} = ${relu ? `max(a${q}_${o}, vec4f(0.0))` : `a${q}_${o}`};`);
          for (let k = 0; k < 4; k++) lines.push(`    dst[(${o * 4 + k}u * p.B + u32(y)) * p.W + x] = v${o}[${k}];`);
        }
      }
      lines.push('  }');
    }

    return `
struct Params { W: u32, B: u32, a: u32, H: u32, k0: u32, k1: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> w: array<vec4f, ${N + O4}>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
${skip ? '@group(0) @binding(4) var<storage, read> skipped: array<f32>;' : ''}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let x0 = i32(g.x) * ${PX};
  let y = i32(g.y);
  if (x0 >= i32(p.W) || y >= i32(p.B)) { return; }
  ${outC === 4 ? 'if (u32(y) < p.k0 || u32(y) >= p.k1) { return; }   // only the rows this band keeps' : ''}
${lines.join('\n')}
}`;
  }

  const LUMA = `
struct Size { W: u32, H: u32 }
@group(0) @binding(0) var<uniform> s: Size;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> luma: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= s.W || g.y >= s.H) { return; }
  let c = textureLoad(img, g.xy, 0).rgb;
  luma[g.y * s.W + g.x] = dot(c, vec3f(0.299, 0.587, 0.114));
}`;

  // Separable Lanczos-3 written as one 2D pass: the weight of a tap is the product of its
  // two axis weights, and taps off the image are dropped and the rest renormalised.
  const FINAL = `
struct F { srcW: f32, srcH: f32, outW: f32, outH: f32 }
@group(0) @binding(0) var<uniform> f: F;
@group(0) @binding(1) var<storage, read> big: array<f32>;
@group(0) @binding(2) var img: texture_2d<f32>;

const PI = 3.141592653589793;

fn lanczos(t: f32) -> f32 {
  let x = abs(t);
  if (x < 1e-5) { return 1.0; }
  if (x >= 3.0) { return 0.0; }
  let a = PI * x;
  return (sin(a) / a) * (sin(a / 3.0) / (a / 3.0));
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // one oversized triangle covers the target with no vertex buffer
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let out = vec2f(f.outW, f.outH);

  // luma, from the network's 2x grid
  let n2 = vec2f(2.0 * f.srcW, 2.0 * f.srcH);
  let s2 = out / n2;
  let widen = max(vec2f(1.0), 1.0 / s2);
  let c2 = pos.xy / s2 - 0.5;
  let r2 = 3.0 * widen;
  let lo2 = max(vec2i(floor(c2 - r2)) + 1, vec2i(0));
  let hi2 = min(vec2i(floor(c2 + r2)), vec2i(n2) - 1);
  var ly = 0.0;
  var lw = 0.0;
  for (var ty = lo2.y; ty <= hi2.y; ty++) {
    let wy = lanczos((f32(ty) - c2.y) / widen.y);
    for (var tx = lo2.x; tx <= hi2.x; tx++) {
      let wt = wy * lanczos((f32(tx) - c2.x) / widen.x);
      ly += wt * big[u32(ty) * u32(n2.x) + u32(tx)];
      lw += wt;
    }
  }

  // chroma, from the source grid; only ever magnified here, so no widening
  let n1 = vec2f(f.srcW, f.srcH);
  let s1 = out / n1;
  let c1 = pos.xy / s1 - 0.5;
  let lo1 = max(vec2i(floor(c1 - 3.0)) + 1, vec2i(0));
  let hi1 = min(vec2i(floor(c1 + 3.0)), vec2i(n1) - 1);
  var cc = vec2f(0.0);
  var cw = 0.0;
  for (var ty = lo1.y; ty <= hi1.y; ty++) {
    let wy = lanczos(f32(ty) - c1.y);
    for (var tx = lo1.x; tx <= hi1.x; tx++) {
      let wt = wy * lanczos(f32(tx) - c1.x);
      let rgb = textureLoad(img, vec2i(tx, ty), 0).rgb;
      cc += wt * vec2f(dot(rgb, vec3f(-0.168736, -0.331264, 0.5)),
                       dot(rgb, vec3f(0.5, -0.418688, -0.081312)));
      cw += wt;
    }
  }

  let yv = ly / lw;
  let cb = cc.x / cw;
  let cr = cc.y / cw;
  let rgb = vec3f(yv + 1.402 * cr, yv - 0.344136 * cb - 0.714136 * cr, yv + 1.772 * cb);
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

  async function init(weights) {
    try {
      if (!navigator.gpu) return false;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize
        }
      });
      maxBuffer = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
      device.lost.then(() => { ok = false; });

      const bytes = weights instanceof ArrayBuffer ? weights
        : await fetch(weights || 'artcnn-c4f32.bin').then(r => r.arrayBuffer());
      const all = new Float32Array(bytes);
      let at = 0;
      layers = LAYERS.map(([inC, outC, relu, skip], n) => {
        const w = all.subarray(at, at += outC * inC * 9);
        const b = all.subarray(at, at += outC);
        // [out][in][ky][kx] -> [in][ky][kx][out], with the biases after
        const packed = new Float32Array(inC * 9 * outC + outC);
        for (let o = 0; o < outC; o++) {
          for (let i = 0; i < inC; i++) {
            for (let k = 0; k < 9; k++) packed[(i * 9 + k) * outC + o] = w[(o * inC + i) * 9 + k];
          }
        }
        packed.set(b, inC * 9 * outC);
        const buf = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(buf, 0, packed);
        const module = device.createShaderModule({ code: convShader(inC, outC, relu, skip, n === 0) });
        return { weights: buf, skip, pipe: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }) };
      });
      if (at !== all.length) throw new Error('artcnn-c4f32.bin is not the size the network needs');

      lumaPipe = device.createComputePipeline({
        layout: 'auto', compute: { module: device.createShaderModule({ code: LUMA }), entryPoint: 'main' }
      });
      return (ok = true);
    } catch (err) {
      console.warn('ArtCNN unavailable, keeping Lanczos:', err);
      return (ok = false);
    }
  }

  function finalPipe(format) {
    if (!finalPipes.has(format)) {
      const module = device.createShaderModule({ code: FINAL });
      finalPipes.set(format, device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] }
      }));
    }
    return finalPipes.get(format);
  }

  function uniform(values, made) {
    const data = new Uint32Array(Math.ceil(values.length / 4) * 4);
    data.set(values);
    const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    made.push(buf);
    return buf;
  }

  function storage(bytes, made) {
    const buf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
    made.push(buf);
    return buf;
  }

  // Records the page band by band. Every buffer it makes goes into `made`, for run() to free.
  // Returns true once the page is drawn, false if it stopped because it was no longer wanted.
  async function encode(img, W, H, target, format, outW, outH, wanted, made) {
    const bind = (pipe, entries) => device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource: resource.createView ? resource.createView() : { buffer: resource } }))
    });
    const submit = record => {
      const enc = device.createCommandEncoder();
      record(enc);
      device.queue.submit([enc.finish()]);
    };

    const luma = storage(4 * W * H, made);
    const big = storage(16 * W * H, made);
    const rows = Math.min(H, BAND + 2 * HALO);
    const first = storage(4 * 32 * rows * W, made);
    const ping = storage(4 * 32 * rows * W, made);
    const pong = storage(4 * 32 * rows * W, made);

    submit(enc => {
      const pass = enc.beginComputePass();
      pass.setPipeline(lumaPipe);
      pass.setBindGroup(0, bind(lumaPipe, [uniform([W, H], made), img, luma]));
      pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
      pass.end();
    });

    for (let r0 = 0; r0 < H; r0 += BAND) {
      await device.queue.onSubmittedWorkDone();
      if (!wanted()) return false;
      const r1 = Math.min(H, r0 + BAND);
      const a = Math.max(0, r0 - HALO);
      const b = Math.min(H, r1 + HALO);
      const params = uniform([W, b - a, a, H, r0 - a, r1 - a], made);
      const flow = [[luma, first], [first, ping], [ping, pong], [pong, ping], [ping, pong], [pong, ping], [ping, big]];
      submit(enc => {
        const pass = enc.beginComputePass();
        layers.forEach((L, n) => {
          const [src, dst] = flow[n];
          pass.setPipeline(L.pipe);
          pass.setBindGroup(0, bind(L.pipe, [params, L.weights, src, dst].concat(L.skip ? [first] : [])));
          pass.dispatchWorkgroups(Math.ceil(W / PX / 8), Math.ceil((b - a) / 8));
        });
        pass.end();
      });
    }

    await device.queue.onSubmittedWorkDone();
    if (!wanted()) return false;
    const pipe = finalPipe(format);
    const sizes = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(sizes, 0, new Float32Array([W, H, outW, outH]));
    made.push(sizes);
    submit(enc => {
      // the target is fetched only now: a canvas's texture is good for one task
      const draw = enc.beginRenderPass({ colorAttachments: [{ view: target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      draw.setPipeline(pipe);
      draw.setBindGroup(0, bind(pipe, [sizes, big, img]));
      draw.draw(3);
      draw.end();
    });
    return true;
  }

  // Runs one page and tells whether it was drawn. Validation and memory errors in WebGPU do
  // not throw, so they are caught with error scopes; any failure leaves the page to Lanczos.
  // Only one page runs at a time, so the scopes cannot catch another page's errors.
  async function run(work) {
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    const made = [];
    let drawn = false;
    try { drawn = await work(made); } catch (err) { console.warn('ArtCNN:', err); }
    const oom = await device.popErrorScope();
    const invalid = await device.popErrorScope();
    await device.queue.onSubmittedWorkDone();
    made.forEach(b => b.destroy());
    const err = oom || invalid;
    if (err) console.warn('ArtCNN:', err.message);
    return drawn && !err;
  }

  return {
    init,
    available: () => ok,

    // Worth doing whenever the art is magnified at all: the gain held down to 1.1x.
    wants(srcW, srcH, outW, outH) {
      return ok && outW > srcW &&
             Math.max(srcW, srcH, outW, outH) <= MAX_SIDE && 16 * srcW * srcH <= maxBuffer;
    },

    // Draws a picture (an <img> or a canvas) into a canvas at the canvas's own size, once the
    // pages asked for before it are done. The picture is copied at once, so the caller may
    // reuse it on return. The canvas stays transparent until the page is drawn, and the
    // promise then settles true; it settles false if the page failed, or if wanted() said
    // false before the page was finished.
    render(source, canvas, wanted = () => true) {
      if (!ok) return Promise.resolve(false);
      const W = source.naturalWidth || source.width, H = source.naturalHeight || source.height;
      device.pushErrorScope('validation');
      let img = null, threw = false;
      try {
        img = device.createTexture({
          size: [W, H], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        device.queue.copyExternalImageToTexture({ source }, { texture: img }, [W, H]);
      } catch (err) {
        console.warn('ArtCNN:', err);
        threw = true;
      }
      const copied = device.popErrorScope();

      const page = queue.then(() => copied).then(invalid => {
        if (threw || invalid || !wanted()) return false;
        return run(made => {
          const format = navigator.gpu.getPreferredCanvasFormat();
          const ctx = canvas.getContext('webgpu');
          ctx.configure({ device, format, alphaMode: 'premultiplied' });
          return encode(img, W, H, () => ctx.getCurrentTexture().createView(), format,
                        canvas.width, canvas.height, wanted, made);
        });
      }).finally(() => img && img.destroy());
      queue = page.catch(() => {});
      return page;
    }
  };
})();
