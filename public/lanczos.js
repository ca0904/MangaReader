'use strict';

// Lanczos-3 resampling in a fragment shader.
//
// A browser will only ever bilinear-scale an <img>, which on this collection throws away
// about a third of the edge detail when 800px manhwa art is stretched past its own
// resolution.
//
// This is the separable filter, the same one ffmpeg calls lanczos, because that is what
// was measured and agreed on. mpv's ewa_lanczos is the polar variant, which weights taps
// by radial distance through a jinc (Bessel) function rather than a sinc per axis; a
// sinc applied radially is not the same filter and rings hard enough to push edge energy
// above the untouched source.
//
// Upscaling only. The support is fixed at three source pixels, which is correct when
// magnifying; shrinking needs it widened by the inverse ratio or it aliases, and the
// browser's own mipmapped downscaling already handles that well.
const Lanczos = (() => {
  const RADIUS = 3;

  let gl = null, canvas = null, texture = null, uSrcSize = null, ok = null, maxSide = 0;

  const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  // y flipped so uv 0 is the top row of the image, matching how the canvas reads back
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 srcSize;
in vec2 uv;
out vec4 colour;

const float R = ${RADIUS}.0;
const float PI = 3.141592653589793;

float lanczos(float x) {
  x = abs(x);
  if (x < 1e-5) return 1.0;
  if (x >= R) return 0.0;
  float a = PI * x;
  return (sin(a) / a) * (sin(a / R) / (a / R));
}

void main() {
  vec2 pos = uv * srcSize - 0.5;
  vec2 base = floor(pos);
  vec4 sum = vec4(0.0);
  float weight = 0.0;
  for (int dy = -2; dy <= 3; dy++) {
    for (int dx = -2; dx <= 3; dx++) {
      vec2 tap = base + vec2(float(dx), float(dy));
      vec2 d = tap - pos;
      float w = lanczos(d.x) * lanczos(d.y);   // separable: one weight per axis
      if (w != 0.0) {
        sum += texture(src, (tap + 0.5) / srcSize) * w;
        weight += w;
      }
    }
  }
  colour = sum / weight;
}`;

  function init() {
    if (ok !== null) return ok;
    try {
      canvas = document.createElement('canvas');
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
      if (!gl) return (ok = false);

      const compile = (type, source) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, source);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };

      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);

      // one oversized triangle covers the viewport with no index buffer
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const p = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(p);
      gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);

      uSrcSize = gl.getUniformLocation(program, 'srcSize');
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // we pick the texels ourselves, so the hardware must not filter them first
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      maxSide = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      return (ok = true);
    } catch {
      return (ok = false);
    }
  }

  return {
    available: () => init(),

    // Worth doing only when magnifying, and only while everything fits on the GPU.
    wants(srcW, srcH, outW, outH) {
      return init() && outW > srcW &&
             Math.max(srcW, srcH) <= maxSide && Math.max(outW, outH) <= maxSide;
    },

    render(source, srcW, srcH, outW, outH) {
      if (!init()) return null;
      canvas.width = outW;
      canvas.height = outH;
      gl.viewport(0, 0, outW, outH);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform2f(uSrcSize, srcW, srcH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return canvas;
    }
  };
})();
