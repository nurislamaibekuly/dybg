const VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main(){
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const MESH_N = 6;

const FS_MESH = `
precision highp float;
varying vec2 v_uv;

uniform float u_time;
uniform vec2  u_res;
uniform float u_saturation;
uniform float u_brightness;
uniform float u_dithering;

#define N ${MESH_N}

uniform vec2  u_pts[N];
uniform vec3  u_cols[N];
uniform float u_rads[N];
uniform float u_amp[N];
uniform float u_phase[N];

highp float hash(highp vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  float aspect = u_res.x / u_res.y;
  vec2 auv = vec2(v_uv.x * aspect, v_uv.y);

  vec3 acc = vec3(0.0);
  float wsum = 0.0;

  for (int i = 0; i < N; i++) {
    float t = u_time * 0.4 + u_phase[i];
    vec2 drift = vec2(sin(t), cos(t * 0.85)) * u_amp[i];
    vec2 p = u_pts[i] + drift;
    vec2 ap = vec2(p.x * aspect, p.y);

    float d = length(auv - ap) / max(u_rads[i], 1e-4);
    float w = smoothstep(1.0, 0.0, d);
    w = w * w;

    acc  += u_cols[i] * w;
    wsum += w;
  }

  vec3 baseCol = vec3(0.0);
  for (int i = 0; i < N; i++) baseCol += u_cols[i];
  baseCol /= float(N);
  baseCol *= 0.55;

  vec3 blended = wsum > 1e-4 ? acc / wsum : baseCol;

  vec3 rgb = mix(baseCol, blended, clamp(wsum, 0.0, 1.0));

  rgb *= u_brightness;
  float gray = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(gray), rgb, u_saturation);

  highp vec2 pixelPos = floor(v_uv * u_res);
  highp float noise = hash(vec3(pixelPos, floor(u_time * 60.0)));
  rgb += (noise - 0.5) * u_dithering;

  gl_FragColor = vec4(rgb, 1.0);
}`;

const FS_BLUR = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_dir;

void main() {
  vec2 texel = u_dir / u_res;

  vec4 color = vec4(0.0);
  color += texture2D(u_tex, v_uv + texel * -3.0) * 0.015625;
  color += texture2D(u_tex, v_uv + texel * -2.0) * 0.09375;
  color += texture2D(u_tex, v_uv + texel * -1.0) * 0.234375;
  color += texture2D(u_tex, v_uv)                 * 0.3125;
  color += texture2D(u_tex, v_uv + texel *  1.0) * 0.234375;
  color += texture2D(u_tex, v_uv + texel *  2.0) * 0.09375;
  color += texture2D(u_tex, v_uv + texel *  3.0) * 0.015625;

  gl_FragColor = color;
}`;

const FS_OUT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_saturation;
uniform float u_brightness;
uniform float u_time;
uniform vec2 u_res;
uniform float u_scale;
uniform float u_dithering;

highp float hash(highp vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec2 uv = (v_uv - 0.5) / u_scale + 0.5;
  uv = clamp(uv, 0.0, 1.0);

  vec4 color = texture2D(u_tex, uv);

  color.rgb *= u_brightness;
  float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  color.rgb = mix(vec3(gray), color.rgb, u_saturation);

  highp vec2 pixelPos = floor(v_uv * u_res);
  highp float noise = hash(vec3(pixelPos, floor(u_time * 60.0)));
  color.rgb += (noise - 0.5) * u_dithering;

  gl_FragColor = vec4(color.rgb, 1.0);
}`;

const _isMobileDybg =
  /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent) ||
  window.innerWidth <= 768;

export default class Dybg {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { premultipliedAlpha: false });
    if (!this.gl) throw new Error('WebGL not supported');

    const gl = this.gl;

    this.BLUR_PASSES = _isMobileDybg ? 1 : 2;
    this.RES_SCALE = _isMobileDybg ? 0.5 : 1.0;
    this.saturation = 1.2;
    this.brightness = 1.0;
    this.dithering = 0.03;
    this.outScale = 1.02;

    this.running = false;
    this.rafId = null;
    this.startTime = performance.now();
    this.width = 0;
    this.height = 0;

    this.points = new Float32Array(MESH_N * 2);
    this.colors = new Float32Array(MESH_N * 3);
    this.radii = new Float32Array(MESH_N);
    this.amps = new Float32Array(MESH_N);
    this.phases = new Float32Array(MESH_N);
    this._seedDefaults();

    this.programs = {};
    this.locs = {};
    this.buffers = {};
    this.fbos = [];

    this._initBuffers();
    this._initShaders();
    this._setupGLState();

    this.resize();
  }

  _seedDefaults() {
    const pts    = [0.18,0.20,  0.08,0.52,  0.14,0.86,  0.82,0.14,  0.90,0.58,  0.60,0.84];
    const cols   = [0.98,0.16,0.06,  0.84,0.05,0.03,  0.24,0.01,0.01,  0.74,0.04,0.03,  0.70,0.05,0.03,  0.52,0.03,0.02];
    const radii  = [0.72, 0.65, 0.55, 0.70, 0.62, 0.58];
    const amps   = [0.06, 0.05, 0.04, 0.06, 0.05, 0.04];
    const phases = [0.00, 1.10, 2.30, 3.70, 0.80, 5.10];
    for (let i = 0; i < MESH_N; i++) {
      this.points[i * 2]     = pts[i * 2];
      this.points[i * 2 + 1] = pts[i * 2 + 1];
      this.colors[i * 3]     = cols[i * 3];
      this.colors[i * 3 + 1] = cols[i * 3 + 1];
      this.colors[i * 3 + 2] = cols[i * 3 + 2];
      this.radii[i]  = radii[i];
      this.amps[i]   = amps[i];
      this.phases[i] = phases[i];
    }
  }

  _setupGLState() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 1);
  }

  _initBuffers() {
    const gl = this.gl;
    const data = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.buffers.quad = buf;
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }

  _program(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Program link error: ' + log);
    }
    return prog;
  }

  _initShaders() {
    const gl = this.gl;

    this.programs.mesh = this._program(VS, FS_MESH);
    this.programs.blur = this._program(VS, FS_BLUR);
    this.programs.out = this._program(VS, FS_OUT);

    this.locs.mesh = {
      a_pos: gl.getAttribLocation(this.programs.mesh, 'a_pos'),
      a_uv: gl.getAttribLocation(this.programs.mesh, 'a_uv'),
      time: gl.getUniformLocation(this.programs.mesh, 'u_time'),
      res: gl.getUniformLocation(this.programs.mesh, 'u_res'),
      sat: gl.getUniformLocation(this.programs.mesh, 'u_saturation'),
      bri: gl.getUniformLocation(this.programs.mesh, 'u_brightness'),
      dither: gl.getUniformLocation(this.programs.mesh, 'u_dithering'),
      pts: gl.getUniformLocation(this.programs.mesh, 'u_pts'),
      cols: gl.getUniformLocation(this.programs.mesh, 'u_cols'),
      rads: gl.getUniformLocation(this.programs.mesh, 'u_rads'),
      amp: gl.getUniformLocation(this.programs.mesh, 'u_amp'),
      phase: gl.getUniformLocation(this.programs.mesh, 'u_phase'),
    };

    this.locs.blur = {
      a_pos: gl.getAttribLocation(this.programs.blur, 'a_pos'),
      a_uv: gl.getAttribLocation(this.programs.blur, 'a_uv'),
      tex: gl.getUniformLocation(this.programs.blur, 'u_tex'),
      res: gl.getUniformLocation(this.programs.blur, 'u_res'),
      dir: gl.getUniformLocation(this.programs.blur, 'u_dir'),
    };

    this.locs.out = {
      a_pos: gl.getAttribLocation(this.programs.out, 'a_pos'),
      a_uv: gl.getAttribLocation(this.programs.out, 'a_uv'),
      tex: gl.getUniformLocation(this.programs.out, 'u_tex'),
      sat: gl.getUniformLocation(this.programs.out, 'u_saturation'),
      bri: gl.getUniformLocation(this.programs.out, 'u_brightness'),
      time: gl.getUniformLocation(this.programs.out, 'u_time'),
      res: gl.getUniformLocation(this.programs.out, 'u_res'),
      scale: gl.getUniformLocation(this.programs.out, 'u_scale'),
      dither: gl.getUniformLocation(this.programs.out, 'u_dithering'),
    };
  }

  _createFBO(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fb);
      throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
    }

    return { fb, tex, w, h };
  }

  _destroyFBOs() {
    const gl = this.gl;
    for (const f of this.fbos) {
      if (f.fb) gl.deleteFramebuffer(f.fb);
      if (f.tex) gl.deleteTexture(f.tex);
    }
    this.fbos = [];
  }

  _allocFBOs(w, h) {
    this._destroyFBOs();
    this.fbos = [this._createFBO(w, h), this._createFBO(w, h)];
  }

  setCover(img) {
    try {
      const sample = this._samplePalette(img, MESH_N);
      if (sample && sample.length >= MESH_N) {
        const pairs = [];
        for (let pi = 0; pi < MESH_N; pi++) {
          const px = this.points[pi * 2];
          const py = this.points[pi * 2 + 1];
          for (let ci = 0; ci < sample.length; ci++) {
            const dx = sample[ci][3] - px;
            const dy = sample[ci][4] - py;
            pairs.push({ pi, ci, d: dx * dx + dy * dy });
          }
        }
        pairs.sort((a, b) => a.d - b.d);

        const usedPoints = new Set();
        const usedClusters = new Set();
        const assignment = new Array(MESH_N).fill(-1);
        for (const pr of pairs) {
          if (usedPoints.has(pr.pi) || usedClusters.has(pr.ci)) continue;
          assignment[pr.pi] = pr.ci;
          usedPoints.add(pr.pi);
          usedClusters.add(pr.ci);
          if (usedPoints.size === MESH_N) break;
        }

        for (let i = 0; i < MESH_N; i++) {
          const c = sample[assignment[i]];
          this.colors[i * 3] = c[0];
          this.colors[i * 3 + 1] = c[1];
          this.colors[i * 3 + 2] = c[2];
        }
      }
    } catch (e) {
      console.warn('Dybg.setCover: palette sampling failed, using defaults.', e);
    }
  }

  _samplePalette(img, count) {
    const S = 48;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const iw = img.naturalWidth || img.width || S;
    const ih = img.naturalHeight || img.height || S;
    const scale = Math.max(S / iw, S / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (S - dw) / 2;
    const dy = (S - dh) / 2;

    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(img, dx, dy, dw, dh);

    let data;
    try {
      data = ctx.getImageData(0, 0, S, S).data;
    } catch (e) {
      return null;
    }

    const pixels = [];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const a = data[i + 3];
        if (a < 16) continue;
        pixels.push({
          r: data[i] / 255,
          g: data[i + 1] / 255,
          b: data[i + 2] / 255,
          x: x / (S - 1),
          y: y / (S - 1),
        });
      }
    }
    if (pixels.length === 0) return null;

    const k = Math.min(count, pixels.length);
    const centroids = [];
    const seedStride = pixels.length / k;
    for (let i = 0; i < k; i++) {
      const p = pixels[Math.min(Math.floor(i * seedStride), pixels.length - 1)];
      centroids.push({ r: p.r, g: p.g, b: p.b });
    }

    const assign = new Int32Array(pixels.length);
    const ITERATIONS = 6;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (let pi = 0; pi < pixels.length; pi++) {
        const p = pixels[pi];
        let best = 0;
        let bestDist = Infinity;
        for (let ci = 0; ci < k; ci++) {
          const cen = centroids[ci];
          const dr = p.r - cen.r;
          const dg = p.g - cen.g;
          const db = p.b - cen.b;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) {
            bestDist = dist;
            best = ci;
          }
        }
        assign[pi] = best;
      }

      const sums = [];
      for (let ci = 0; ci < k; ci++) {
        sums.push({ r: 0, g: 0, b: 0, x: 0, y: 0, n: 0 });
      }
      for (let pi = 0; pi < pixels.length; pi++) {
        const p = pixels[pi];
        const s = sums[assign[pi]];
        s.r += p.r; s.g += p.g; s.b += p.b;
        s.x += p.x; s.y += p.y; s.n++;
      }
      for (let ci = 0; ci < k; ci++) {
        const s = sums[ci];
        if (s.n > 0) {
          centroids[ci] = {
            r: s.r / s.n, g: s.g / s.n, b: s.b / s.n,
            x: s.x / s.n, y: s.y / s.n, n: s.n,
          };
        } else {
          const p = pixels[Math.floor(Math.random() * pixels.length)];
          centroids[ci] = { r: p.r, g: p.g, b: p.b, x: p.x, y: p.y, n: 0 };
        }
      }
    }

    centroids.sort((a, b) => (b.n || 0) - (a.n || 0));

    const out = [];
    for (let i = 0; i < count; i++) {
      const cen = centroids[i % centroids.length];
      let r = cen.r, g = cen.g, b = cen.b;

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 0.12) {
        const lift = 0.12 - lum;
        r = Math.min(1, r + lift);
        g = Math.min(1, g + lift);
        b = Math.min(1, b + lift);
      }

      out.push([r, g, b, cen.x, cen.y]);
    }
    return out;
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, _isMobileDybg ? 2 : 2);

    const cssW = Math.max(1, this.canvas.clientWidth || window.innerWidth || 1);
    const cssH = Math.max(1, this.canvas.clientHeight || window.innerHeight || 1);

    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));

    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const iw = Math.max(1, Math.floor(w * this.RES_SCALE));
    const ih = Math.max(1, Math.floor(h * this.RES_SCALE));
    this.iw = iw;
    this.ih = ih;

    this._allocFBOs(iw, ih);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startTime = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.render();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  _bindQuad(aPos, aUv) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.quad);
    const stride = 4 * 4;
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 2 * 4);
  }

  _drawQuad() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  render() {
    const gl = this.gl;

    if (this.fbos.length < 2) return;

    const time = (performance.now() - this.startTime) / 1000;

    const src = this.fbos[0];
    const dst = this.fbos[1];

    gl.bindFramebuffer(gl.FRAMEBUFFER, src.fb);
    gl.viewport(0, 0, this.iw, this.ih);
    gl.useProgram(this.programs.mesh);

    const m = this.locs.mesh;
    gl.uniform1f(m.time, time);
    gl.uniform2f(m.res, this.iw, this.ih);
    gl.uniform1f(m.sat, this.saturation);
    gl.uniform1f(m.bri, this.brightness);
    gl.uniform1f(m.dither, this.dithering);
    gl.uniform2fv(m.pts, this.points);
    gl.uniform3fv(m.cols, this.colors);
    gl.uniform1fv(m.rads, this.radii);
    gl.uniform1fv(m.amp, this.amps);
    gl.uniform1fv(m.phase, this.phases);

    this._bindQuad(m.a_pos, m.a_uv);
    this._drawQuad();

    gl.useProgram(this.programs.blur);
    const b = this.locs.blur;
    gl.uniform1i(b.tex, 0);
    gl.uniform2f(b.res, this.iw, this.ih);
    gl.activeTexture(gl.TEXTURE0);

    let read = src;
    let write = dst;
    for (let i = 0; i < this.BLUR_PASSES; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fb);
      gl.viewport(0, 0, this.iw, this.ih);
      gl.bindTexture(gl.TEXTURE_2D, read.tex);
      gl.uniform2f(b.dir, 1.0, 0.0);
      this._bindQuad(b.a_pos, b.a_uv);
      this._drawQuad();

      let tmp = read;
      read = write;
      write = tmp;

      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fb);
      gl.viewport(0, 0, this.iw, this.ih);
      gl.bindTexture(gl.TEXTURE_2D, read.tex);
      gl.uniform2f(b.dir, 0.0, 1.0);
      this._bindQuad(b.a_pos, b.a_uv);
      this._drawQuad();

      tmp = read;
      read = write;
      write = tmp;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.programs.out);

    const o = this.locs.out;
    gl.uniform1i(o.tex, 0);
    gl.uniform1f(o.sat, this.saturation);
    gl.uniform1f(o.bri, this.brightness);
    gl.uniform1f(o.time, time);
    gl.uniform2f(o.res, this.width, this.height);
    gl.uniform1f(o.scale, this.outScale);
    gl.uniform1f(o.dither, this.dithering);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);

    this._bindQuad(o.a_pos, o.a_uv);
    this._drawQuad();
  }

  dispose() {
    const gl = this.gl;
    this.stop();

    this._destroyFBOs();

    if (this.buffers.quad) gl.deleteBuffer(this.buffers.quad);
    this.buffers = {};

    for (const key of Object.keys(this.programs)) {
      if (this.programs[key]) gl.deleteProgram(this.programs[key]);
    }
    this.programs = {};
    this.locs = {};

    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();

    this.gl = null;
    this.canvas = null;
  }
}
