export class MeshGradient {
  constructor(options = {}) {
    const {
      container = document.body,
      colors = ['#cc1122', '#00cccc', '#880022', '#004444', '#ee2244', '#0099aa'],
      background = '#050506',
      numBlobs = 8,
      blur = 110,
      speed = 0.18,
      saturation = 2.5,
      contrast = 1.08,
      brightness = 0.78,
    } = options;

    this._colors = colors.map(c => this._hexToRgb(c));
    this._bgRgb = this._hexToRgb(background);
    this._numBlobs = numBlobs;
    this._blurPx = blur;
    this._speed = speed;
    this._saturation = saturation;
    this._contrast = contrast;
    this._brightness = brightness;
    this._animId = null;
    this._startTime = 0;
    this._W = 0;
    this._H = 0;

    this._container = container instanceof HTMLElement
      ? container
      : document.querySelector(container);
    if (!this._container) throw new Error('MeshGradient: container not found');


    this._root = document.createElement('div');
    this._root.style.cssText = `position:fixed;inset:0;overflow:hidden;background:${background};`;
    this._container.appendChild(this._root);


    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;`;
    this._root.appendChild(this._canvas);


    this._blobs = this._initBlobs();


    try { this._gl = this._canvas.getContext('webgl', { alpha: false, antialias: false }); } catch (_) { }
    if (this._gl && !this._gl.isContextLost()) {
      this._initGL();
    } else {
      this._gl = null;

      this._ctx2d = this._canvas.getContext('2d');
    }

    this._resize();
    window.addEventListener('resize', this._onResize = () => this._resize());
    this._animId = requestAnimationFrame(t => this._loop(t));
  }

  _hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3
      ? h.split('').map(c => c + c).join('')
      : h, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  _initBlobs() {
    const blobs = [];
    for (let i = 0; i < this._numBlobs; i++) {
      blobs.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.0003,
        vy: (Math.random() - 0.5) * 0.0003,

        px: Math.random() * Math.PI * 2,
        py: Math.random() * Math.PI * 2,
        fx: 0.15 + Math.random() * 0.25,
        fy: 0.12 + Math.random() * 0.22,
        ax: 0.08 + Math.random() * 0.18,
        ay: 0.06 + Math.random() * 0.16,
        cx: 0.1 + Math.random() * 0.8,
        cy: 0.1 + Math.random() * 0.8,
        size: 0.3 + Math.random() * 0.55,
        weight: 0.6 + Math.random() * 1.2,
        ci: i % this._colors.length,
      });
    }
    return blobs;
  }

  _resize() {
    this._W = this._root.clientWidth || window.innerWidth;
    this._H = this._root.clientHeight || window.innerHeight;
    this._canvas.width = this._W;
    this._canvas.height = this._H;
    const gl = this._gl;
    if (gl) {
      this._fboW = Math.max(1, Math.round(this._W / 2));
      this._fboH = Math.max(1, Math.round(this._H / 2));
      this._createFBOs();
    }
  }



  _compileShader(src, type) {
    const gl = this._gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error('MeshGradient shader error:', gl.getShaderInfoLog(s));
    return s;
  }

  _createProgram(vsSrc, fsSrc) {
    const gl = this._gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this._compileShader(vsSrc, gl.VERTEX_SHADER));
    gl.attachShader(prog, this._compileShader(fsSrc, gl.FRAGMENT_SHADER));
    gl.linkProgram(prog);
    return prog;
  }

  _vsSrc() {
    return `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        v_uv.y = 1.0 - v_uv.y;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
  }

  _blobFsSrc(n) {
    return `
      precision highp float;
      varying vec2 v_uv;
      uniform vec2  u_aspect;    // (W/H, 1)
      uniform vec3  u_bg;
      uniform vec3  u_colors[${n}];
      uniform vec2  u_pos[${n}];
      uniform float u_size[${n}];
      uniform float u_weight[${n}];

      void main(){
        vec2 uv = v_uv * u_aspect;
        vec3 col = u_bg;
        float totalW = 0.0;

        for(int i = 0; i < ${n}; i++){
          vec2  bp   = u_pos[i] * u_aspect;
          float sz   = u_size[i] * u_aspect.x;
          float d    = length(uv - bp);
          float r    = sz * 0.5;
          // Smooth radial influence: 1 at center, 0 at edge
          float inf  = max(0.0, 1.0 - d / r);
          inf = inf * inf * inf;        // cubic falloff — very soft
          inf *= u_weight[i];
          col     += u_colors[i] * inf;
          totalW  += inf;
        }
        // Blend: blobs over background
        float alpha = clamp(totalW, 0.0, 1.0);
        col = mix(u_bg, col / max(totalW, 0.001), alpha);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `;
  }

  _kawaseFsSrc() {
    return `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec2 u_texel;
      uniform float u_iter;
      void main(){
        vec2 halfT = u_texel * 0.5;
        vec2 d = u_texel * u_iter + halfT;
        vec4 c = texture2D(u_tex, v_uv + vec2(-d.x,  d.y));
        c    += texture2D(u_tex, v_uv + vec2( d.x,  d.y));
        c    += texture2D(u_tex, v_uv + vec2( d.x, -d.y));
        c    += texture2D(u_tex, v_uv + vec2(-d.x, -d.y));
        gl_FragColor = c * 0.25;
      }
    `;
  }

  _postFsSrc() {
    return `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_tex;
      uniform float u_sat;
      uniform float u_con;
      uniform float u_bri;
      void main(){
        vec4 c = texture2D(u_tex, v_uv);
        // brightness
        c.rgb *= u_bri;
        // saturation
        float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
        c.rgb = mix(vec3(lum), c.rgb, u_sat);
        // contrast
        c.rgb = (c.rgb - 0.5) * u_con + 0.5;
        gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
      }
    `;
  }

  _initGL() {
    const gl = this._gl;
    const n = this._numBlobs;


    this._buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);


    this._blobProg = this._createProgram(this._vsSrc(), this._blobFsSrc(n));
    gl.useProgram(this._blobProg);
    const blobPos = gl.getAttribLocation(this._blobProg, 'a_pos');
    gl.enableVertexAttribArray(blobPos);
    gl.vertexAttribPointer(blobPos, 2, gl.FLOAT, false, 0, 0);
    this._uAspect = gl.getUniformLocation(this._blobProg, 'u_aspect');
    this._uBg = gl.getUniformLocation(this._blobProg, 'u_bg');
    this._uColors = [];
    this._uPos = [];
    this._uSize = [];
    this._uWeight = [];
    for (let i = 0; i < n; i++) {
      this._uColors.push(gl.getUniformLocation(this._blobProg, `u_colors[${i}]`));
      this._uPos.push(gl.getUniformLocation(this._blobProg, `u_pos[${i}]`));
      this._uSize.push(gl.getUniformLocation(this._blobProg, `u_size[${i}]`));
      this._uWeight.push(gl.getUniformLocation(this._blobProg, `u_weight[${i}]`));
    }


    this._kawaseProg = this._createProgram(this._vsSrc(), this._kawaseFsSrc());
    gl.useProgram(this._kawaseProg);
    const kPos = gl.getAttribLocation(this._kawaseProg, 'a_pos');
    gl.enableVertexAttribArray(kPos);
    gl.vertexAttribPointer(kPos, 2, gl.FLOAT, false, 0, 0);
    this._kTex = gl.getUniformLocation(this._kawaseProg, 'u_tex');
    this._kTexel = gl.getUniformLocation(this._kawaseProg, 'u_texel');
    this._kIter = gl.getUniformLocation(this._kawaseProg, 'u_iter');
    gl.uniform1i(this._kTex, 0);


    this._postProg = this._createProgram(this._vsSrc(), this._postFsSrc());
    gl.useProgram(this._postProg);
    const pPos = gl.getAttribLocation(this._postProg, 'a_pos');
    gl.enableVertexAttribArray(pPos);
    gl.vertexAttribPointer(pPos, 2, gl.FLOAT, false, 0, 0);
    this._pTex = gl.getUniformLocation(this._postProg, 'u_tex');
    this._pSat = gl.getUniformLocation(this._postProg, 'u_sat');
    this._pCon = gl.getUniformLocation(this._postProg, 'u_con');
    this._pBri = gl.getUniformLocation(this._postProg, 'u_bri');
    gl.uniform1i(this._pTex, 0);


    this._blobTex = this._mkTex(1, 1);
    this._blobFBO = this._mkFBO(this._blobTex, 1, 1);

    this._fboW = 1; this._fboH = 1;
    this._createFBOs();
  }

  _mkTex(w, h) {
    const gl = this._gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _mkFBO(tex, w, h) {
    const gl = this._gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  _resizeTex(tex, w, h) {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  _createFBOs() {
    const gl = this._gl;
    if (!gl) return;


    const bw = Math.max(1, Math.round(this._W / 2));
    const bh = Math.max(1, Math.round(this._H / 2));
    if (!this._blobTex) { this._blobTex = this._mkTex(bw, bh); this._blobFBO = this._mkFBO(this._blobTex, bw, bh); }
    else this._resizeTex(this._blobTex, bw, bh);
    this._blobW = bw; this._blobH = bh;


    if (this._fboATex) { gl.deleteTexture(this._fboATex); gl.deleteFramebuffer(this._fboA); }
    if (this._fboBTex) { gl.deleteTexture(this._fboBTex); gl.deleteFramebuffer(this._fboB); }
    this._fboATex = this._mkTex(this._fboW, this._fboH);
    this._fboA = this._mkFBO(this._fboATex, this._fboW, this._fboH);
    this._fboBTex = this._mkTex(this._fboW, this._fboH);
    this._fboB = this._mkFBO(this._fboBTex, this._fboW, this._fboH);
  }



  _updateBlobs(t) {
    const s = this._speed;
    for (const b of this._blobs) {

      b.x = b.cx + Math.sin(t * b.fx + b.px) * b.ax;
      b.y = b.cy + Math.cos(t * b.fy + b.py) * b.ay;
    }
  }

  _renderGL(t) {
    const gl = this._gl;
    const n = this._numBlobs;
    const aspect = this._W / this._H;


    gl.bindFramebuffer(gl.FRAMEBUFFER, this._blobFBO);
    gl.viewport(0, 0, this._blobW, this._blobH);
    gl.useProgram(this._blobProg);
    gl.uniform2f(this._uAspect, aspect, 1.0);
    gl.uniform3fv(this._uBg, this._bgRgb);
    for (let i = 0; i < n; i++) {
      const b = this._blobs[i];
      const c = this._colors[b.ci];
      gl.uniform3fv(this._uColors[i], c);
      gl.uniform2f(this._uPos[i], b.x, b.y);
      gl.uniform1f(this._uSize[i], b.size);
      gl.uniform1f(this._uWeight[i], b.weight);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);


    const numPasses = Math.max(0, Math.round(this._blurPx / 7));
    let readTex = this._blobTex;
    let writeFbo = this._fboA;
    let readW = this._blobW, readH = this._blobH;

    for (let i = 0; i < numPasses; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
      gl.viewport(0, 0, this._fboW, this._fboH);
      gl.useProgram(this._kawaseProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.uniform2f(this._kTexel, 1.0 / readW, 1.0 / readH);
      gl.uniform1f(this._kIter, i + 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (writeFbo === this._fboA) {
        readTex = this._fboATex; writeFbo = this._fboB;
      } else {
        readTex = this._fboBTex; writeFbo = this._fboA;
      }
      readW = this._fboW; readH = this._fboH;
    }


    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._W, this._H);
    gl.useProgram(this._postProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readTex);
    gl.uniform1f(this._pSat, this._saturation);
    gl.uniform1f(this._pCon, this._contrast);
    gl.uniform1f(this._pBri, this._brightness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _render2D(t) {

    const ctx = this._ctx2d;
    const W = this._W, H = this._H;
    const bg = this._bgRgb;
    ctx.fillStyle = `rgb(${Math.round(bg[0] * 255)},${Math.round(bg[1] * 255)},${Math.round(bg[2] * 255)})`;
    ctx.fillRect(0, 0, W, H);
    for (const b of this._blobs) {
      const c = this._colors[b.ci];
      const x = b.x * W, y = b.y * H;
      const r = b.size * Math.max(W, H) * 0.6;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},0.8)`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  _loop(now) {
    if (this._startTime === 0) this._startTime = now;
    const t = (now - this._startTime) * 0.001 * this._speed;
    this._updateBlobs(t);
    if (this._gl) this._renderGL(t);
    else this._render2D(t);
    this._animId = requestAnimationFrame(ts => this._loop(ts));
  }



  get blur() { return this._blurPx; }
  set blur(v) { this._blurPx = Math.max(0, Math.min(200, v)); }

  get speed() { return this._speed; }
  set speed(v) { this._speed = v; }

  get saturation() { return this._saturation; }
  set saturation(v) { this._saturation = v; }

  get paused() { return this._animId === null; }

  pause() {
    if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
  }

  play() {
    if (!this._animId) {
      this._startTime = 0;
      this._animId = requestAnimationFrame(t => this._loop(t));
    }
  }


  randomize() {
    this._blobs = this._initBlobs();
  }

  destroy() {
    this.pause();
    window.removeEventListener('resize', this._onResize);
    this._root.remove();
    const gl = this._gl;
    if (gl) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  }
}









const _MGR_EASE = (x) =>
  0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));
const _MGR_CLAMP01 = (v) => Math.max(0, Math.min(1, v));
const _MG_COMP_LONG = 640;
const _MG_PLAYBACK_MS = 1000;
const _MG_TAU = Math.PI * 2;
const _MG_BREATH_PERIOD = 40000;
const _MG_BREATH_FADE = 2500;
const _MG_EASE = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Vertex stage for the quad-union backdrop mesh. The grid/warp blend at the
// bottom is the deformation recovered from Apple Music's MediaCoreUI
// `pinch_vertex` (see ylscratch/gtrace/apple-music-212-findings.md):
//
//   warp  = (1 - warpMix) * 0.5 + 2.0            -> 2.5 .. 2.0
//   grid  = (position - 0.5) * warp
//   p     = mix(grid, mix(from, to, transitionMix), warpMix)
//
// `a_pos` is already the mesh's `2 * (uv - 0.5)`, so the same grid term is
// `a_pos * 0.5 * warp`. `a_from` is the vertex's resting grid position and
// `a_to` its warped counterpart; the animated flow and breathing ride on `to`,
// which is where Apple's `toPosition` carries its motion.
const _MGR_VERT = `
precision mediump float;
attribute vec2 a_pos;
attribute vec3 a_color;
attribute vec2 a_uv;
attribute vec2 a_from;
attribute vec2 a_to;
varying vec3 v_color;
varying vec2 v_uv;
uniform float u_aspect;
uniform float u_time;
uniform float u_motion;
uniform float u_breath;
uniform float u_breathPhase;
uniform float u_breathPosition;
uniform float u_breathWarp;
uniform float u_breathWave;
uniform float u_warpMix;
uniform float u_transitionMix;
void main(){
  v_color = a_color;
  v_uv = a_uv;
  float phase = u_time * 0.001;
  float amplitude = 0.045 * u_motion;
  vec2 flow = vec2(0.0);
  flow.x += sin(a_pos.y * 2.7 + phase) * amplitude;
  flow.x += sin(a_pos.y * 5.1 - phase * 0.63) * amplitude * 0.28;
  flow.y += sin(a_pos.x * 2.2 - phase * 0.82) * amplitude * 0.8;
  flow.y += sin(a_pos.x * 4.3 + phase * 0.51) * amplitude * 0.22;
  float breath = cos(u_breathPhase + (a_pos.x + a_pos.y) * (1.15 + u_breathWave));
  vec2 to = a_to + flow;
  to *= 1.0 + breath * u_breath * u_breathWarp * 0.025;
  to += vec2(sin(u_breathPhase + a_pos.y), cos(u_breathPhase + a_pos.x))
    * u_breath * u_breathPosition * 0.018;
  float warp = (1.0 - u_warpMix) * 0.5 + 2.0;
  vec2 grid = a_pos * (0.5 * warp);
  vec2 pos = mix(grid, mix(a_from, to, u_transitionMix), u_warpMix);
  if (u_aspect > 1.0) {
    pos.y *= u_aspect;
  } else {
    pos.x /= u_aspect;
  }
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;


const _MGR_FRAG = `
precision mediump float;
varying vec3 v_color;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_volume;
uniform float u_alpha;
uniform float u_sinAngle;
uniform float u_cosAngle;
const float INV_255 = 1.0 / 255.0;
const float HALF_INV_255 = 0.5 / 255.0;
const float GRADIENT_NOISE_A = 52.9829189;
const vec2 GRADIENT_NOISE_B = vec2(0.06711056, 0.00583715);
float gradientNoise(in vec2 uv) {
  return fract(GRADIENT_NOISE_A * fract(dot(uv, GRADIENT_NOISE_B)));
}
void main(){
  float volumeEffect = u_volume * 2.0;
  float dither = INV_255 * gradientNoise(gl_FragCoord.xy) - HALF_INV_255;
  vec2 centeredUV = v_uv - vec2(0.5);
  vec2 rotatedUV = vec2(
    u_cosAngle * centeredUV.x - u_sinAngle * centeredUV.y,
    u_sinAngle * centeredUV.x + u_cosAngle * centeredUV.y
  );
  vec2 finalUV = rotatedUV * max(0.001, 1.0 - volumeEffect) + vec2(0.5);
  finalUV = vec2(
    1.0 - abs(mod(finalUV.x, 2.0) - 1.0),
    1.0 - abs(mod(finalUV.y, 2.0) - 1.0)
  );
  vec4 result = texture2D(u_texture, finalUV);
  float alphaVolumeFactor = u_alpha * max(0.5, 1.0 - u_volume * 0.5);
  result.rgb *= v_color * alphaVolumeFactor;
  result.a *= alphaVolumeFactor;
  result.rgb += vec3(dither);
  float dist = distance(v_uv, vec2(0.5));
  float vignette = smoothstep(0.8, 0.3, dist);
  float mask = 0.6 + vignette * 0.4;
  result.rgb *= mask;
  gl_FragColor = result;
}
`;


const _MGR_QUAD_VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const _MGR_QUAD_FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_alpha;
void main(){
  vec4 c = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(c.rgb, c.a * u_alpha);
}
`;

function _mgProgram(gl, vsSrc, fsSrc, label) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`${label} shader error: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`${label} program error: ${gl.getProgramInfoLog(prog)}`);
  }
  const attrs = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveAttrib(prog, i);
    if (info) attrs[info.name] = gl.getAttribLocation(prog, info.name);
  }
  return { prog, attrs };
}



// Vertex stride: a_pos(2) a_color(3) a_uv(2) a_from(2) a_to(2).
const _MG_MESH_FLOATS = 11;
// 33x33 control points == the 1,089-vertex 32x32 cell mesh in the Music trace.
const _MG_MESH_CONTROLS = 33;

// Apple Music's backdrop mesh geometry, from MediaCoreUI's static control-point
// tables (see ~/ylscratch/gtrace/apple-music-212-findings.md, section 9). A
// layout draws one of the five "wide" warp cases uniformly at random, as Apple's
// `Int.random(in: 0..<5)` does. Each case is a 9x9 control lattice for the `to`
// field, with `from` the same for every case: the plain grid, with a 0.005
// separable ripple. Two quad-union subdivision levels take each lattice to the
// 33x33 mesh the Music trace captured. Lattice coordinates are in [0, 1].
const _MG_WARP_FROM = [
      [0.0000, 0.0000], [0.1300, 0.0000], [0.2500, 0.0000], [0.3800, 0.0000], [0.5000, 0.0000], [0.6300, 0.0000], [0.7500, 0.0000], [0.8800, 0.0000], [1.0000, 0.0000],
      [0.0000, 0.1300], [0.1300, 0.1300], [0.2500, 0.1300], [0.3800, 0.1300], [0.5000, 0.1300], [0.6300, 0.1300], [0.7500, 0.1300], [0.8800, 0.1300], [1.0000, 0.1300],
      [0.0000, 0.2500], [0.1300, 0.2500], [0.2500, 0.2500], [0.3800, 0.2500], [0.5000, 0.2500], [0.6300, 0.2500], [0.7500, 0.2500], [0.8800, 0.2500], [1.0000, 0.2500],
      [0.0000, 0.3800], [0.1300, 0.3800], [0.2500, 0.3800], [0.3800, 0.3800], [0.5000, 0.3800], [0.6300, 0.3800], [0.7500, 0.3800], [0.8800, 0.3800], [1.0000, 0.3800],
      [0.0000, 0.5000], [0.1300, 0.5000], [0.2500, 0.5000], [0.3800, 0.5000], [0.5000, 0.5000], [0.6300, 0.5000], [0.7500, 0.5000], [0.8800, 0.5000], [1.0000, 0.5000],
      [0.0000, 0.6300], [0.1300, 0.6300], [0.2500, 0.6300], [0.3800, 0.6300], [0.5000, 0.6300], [0.6300, 0.6300], [0.7500, 0.6300], [0.8800, 0.6300], [1.0000, 0.6300],
      [0.0000, 0.7500], [0.1300, 0.7500], [0.2500, 0.7500], [0.3800, 0.7500], [0.5000, 0.7500], [0.6300, 0.7500], [0.7500, 0.7500], [0.8800, 0.7500], [1.0000, 0.7500],
      [0.0000, 0.8800], [0.1300, 0.8800], [0.2500, 0.8800], [0.3800, 0.8800], [0.5000, 0.8800], [0.6300, 0.8800], [0.7500, 0.8800], [0.8800, 0.8800], [1.0000, 0.8800],
      [0.0000, 1.0000], [0.1300, 1.0000], [0.2500, 1.0000], [0.3800, 1.0000], [0.5000, 1.0000], [0.6300, 1.0000], [0.7500, 1.0000], [0.8800, 1.0000], [1.0000, 1.0000],
];

const _MG_WARP_TO = [
  [  // case 0
      [-0.2292, -0.0529], [-0.0402, -0.1270], [0.1116, -0.3122], [0.0923, -0.3360], [1.1205, -0.1640], [1.0089, -0.0635], [1.1205, -0.0529], [1.1116, -0.0899], [1.1979, -0.0741],
      [-0.2202, 0.2685], [0.0238, 0.1435], [0.0997, 0.0933], [0.0774, 0.1091], [0.7500, 0.0933], [0.7738, 0.1091], [0.7991, 0.1435], [1.2798, 0.0880], [1.1801, 0.1435],
      [-0.1667, 0.3611], [0.0432, 0.2500], [0.1116, 0.2500], [0.0923, 0.2791], [0.5387, 0.2791], [0.5908, 0.3161], [0.6250, 0.3161], [0.9896, 0.2791], [1.0893, 0.2341],
      [-0.1176, 0.4544], [0.0625, 0.3909], [0.1503, 0.4418], [0.1637, 0.4306], [0.4836, 0.3909], [0.6161, 0.4544], [0.6458, 0.4544], [0.7411, 0.3909], [1.0640, 0.3380],
      [-0.0625, 0.5344], [0.0997, 0.5159], [0.2664, 0.5721], [0.2589, 0.5721], [0.4836, 0.5344], [0.7113, 0.5344], [0.7411, 0.5344], [0.7991, 0.5159], [1.0461, 0.5000],
      [-0.0402, 0.6574], [0.3750, 0.7130], [0.3929, 0.6574], [0.3750, 0.6250], [0.5000, 0.6038], [0.7991, 0.5721], [0.8080, 0.6250], [0.8750, 0.6250], [1.0461, 0.6435],
      [-0.0298, 0.7685], [0.3586, 0.9041], [0.4063, 0.8003], [0.4568, 0.7500], [0.6250, 0.6574], [0.8616, 0.6700], [0.8408, 0.7130], [0.8943, 0.7288], [1.1265, 0.8214],
      [-0.0402, 0.9041], [0.2589, 1.0152], [0.4747, 0.9676], [0.4568, 0.8882], [0.7411, 0.8538], [0.8616, 0.8538], [0.8408, 0.8750], [0.9211, 0.9438], [1.1116, 0.9676],
      [-0.0625, 1.0979], [0.0238, 1.2196], [0.3304, 1.0688], [0.3750, 1.0000], [0.7887, 1.0556], [0.8408, 1.0556], [0.8750, 1.0688], [0.9435, 1.0688], [1.0893, 1.2196],
  ],
  [  // case 1
      [-0.1726, -0.1984], [0.0551, -0.2593], [0.2158, -0.2593], [0.3839, -0.1984], [0.5119, -0.1984], [0.6473, -0.1243], [0.7440, -0.2698], [1.0179, -0.4259], [1.2515, -0.2698],
      [0.0000, 0.0562], [0.1250, 0.1971], [0.2381, 0.2679], [0.3750, 0.2917], [0.5000, 0.2202], [0.6250, 0.1250], [0.8467, -0.1111], [1.0000, -0.1528], [1.1042, 0.0146],
      [-0.0193, 0.0357], [0.1250, 0.1766], [0.2500, 0.2500], [0.3750, 0.3082], [0.5000, 0.2500], [0.6250, 0.1766], [0.7887, 0.0146], [0.9598, -0.0648], [1.0551, -0.0172],
      [0.0000, 0.3353], [0.1250, 0.3896], [0.2167, 0.3444], [0.3750, 0.3231], [0.5119, 0.3772], [0.6250, 0.3353], [0.7768, 0.1025], [0.9464, 0.0562], [1.0685, 0.1647],
      [-0.0521, 0.5192], [0.1250, 0.4471], [0.2229, 0.3824], [0.3750, 0.3444], [0.5119, 0.3933], [0.6577, 0.4353], [0.7500, 0.4677], [0.8601, 0.4353], [1.1473, 0.2345],
      [-0.0402, 0.6442], [0.1250, 0.5192], [0.2277, 0.4000], [0.3750, 0.3664], [0.5119, 0.4074], [0.6577, 0.4677], [0.7500, 0.5000], [0.8527, 0.4471], [1.1280, 0.2345],
      [-0.0253, 0.7718], [0.1116, 0.5675], [0.2339, 0.4353], [0.3708, 0.4219], [0.5148, 0.4353], [0.6726, 0.5000], [0.7649, 0.5780], [0.8601, 0.5357], [1.1622, 0.3082],
      [-0.0253, 0.9041], [0.0982, 0.7718], [0.2381, 0.6872], [0.3750, 0.6442], [0.5119, 0.6442], [0.6577, 0.6872], [0.8229, 0.7348], [0.8750, 0.8750], [1.2411, 1.1343],
      [-0.0521, 1.1005], [0.0982, 1.0556], [0.2277, 1.0556], [0.3557, 1.0556], [0.5000, 1.1587], [0.6250, 1.1799], [0.7649, 1.3677], [0.8958, 1.4841], [1.0685, 1.3519],
  ],
  [  // case 2
      [-0.0640, -0.1323], [0.0893, -0.1614], [0.2500, -0.0608], [0.5729, -0.1614], [0.6771, -0.1614], [0.7292, -0.1614], [0.7634, -0.1217], [0.8750, -0.0608], [1.0164, -0.0423],
      [-0.0714, 0.1091], [0.2054, 0.0985], [0.2292, 0.1091], [0.3750, 0.1250], [0.5357, 0.2077], [0.6131, 0.2500], [0.6458, 0.1250], [0.7500, -0.0284], [1.0164, 0.1091],
      [-0.0565, 0.2500], [0.1696, 0.2077], [0.1771, 0.2262], [0.2143, 0.2262], [0.3750, 0.1759], [0.6250, 0.2937], [0.6369, 0.3161], [0.6652, 0.2262], [1.0104, 0.2262],
      [-0.0565, 0.3750], [0.0997, 0.3750], [0.1250, 0.3750], [0.1771, 0.3882], [0.3616, 0.2077], [0.6131, 0.3406], [0.6548, 0.3406], [0.7068, 0.3750], [1.0313, 0.3538],
      [-0.1429, 0.6058], [0.1414, 0.5000], [0.1563, 0.5000], [0.1949, 0.5000], [0.5193, 0.2937], [0.6964, 0.4517], [0.7158, 0.4517], [0.7902, 0.4841], [1.0461, 0.4841],
      [-0.0714, 0.6753], [0.2054, 0.6250], [0.2054, 0.6250], [0.2292, 0.6250], [0.6131, 0.3750], [0.7158, 0.5298], [0.7634, 0.5456], [0.8557, 0.6250], [1.0789, 0.6250],
      [-0.0565, 0.8108], [0.2143, 0.7500], [0.2292, 0.7500], [0.2500, 0.7315], [0.6652, 0.6865], [0.7634, 0.6462], [0.8095, 0.7077], [0.8914, 0.7500], [1.0923, 0.7500],
      [-0.0565, 0.9306], [0.2054, 0.9067], [0.2054, 0.9306], [0.2292, 0.9411], [0.6250, 0.8750], [0.7634, 0.7718], [0.8557, 0.8108], [0.9390, 0.8538], [1.0789, 0.9306],
      [0.0000, 1.0000], [-0.0714, 1.2169], [0.1250, 1.4021], [0.2500, 1.0794], [0.6250, 1.0794], [0.7902, 1.0794], [0.8750, 1.0794], [0.9509, 1.0582], [1.0104, 1.0794],
  ],
  [  // case 3
      [-0.2292, -0.3968], [0.0699, -0.3439], [0.2217, -0.1799], [0.3512, -0.1376], [0.6533, -0.2407], [0.6845, -0.1640], [0.7753, -0.3148], [0.9494, -0.3677], [1.3810, -0.5476],
      [-0.1711, 0.0827], [-0.0387, -0.1263], [0.2500, 0.1250], [0.2887, 0.1250], [0.5000, 0.1250], [0.5565, 0.1250], [0.7827, -0.0787], [0.9182, -0.1799], [1.2039, -0.0628],
      [-0.1057, 0.2209], [0.0268, 0.1918], [0.2500, 0.2500], [0.2679, 0.2844], [0.2887, 0.2685], [0.3958, 0.2844], [0.6771, 0.1250], [0.9702, 0.0542], [1.2113, 0.1091],
      [-0.1176, 0.2983], [0.1101, 0.3300], [0.2500, 0.4200], [0.3170, 0.4200], [0.3571, 0.4200], [0.3958, 0.4200], [0.6369, 0.2983], [0.9107, 0.2844], [1.2113, 0.3300],
      [-0.1533, 0.3750], [0.1533, 0.3750], [0.2292, 0.4200], [0.3750, 0.5000], [0.4301, 0.5377], [0.4583, 0.5377], [0.6845, 0.4735], [0.8110, 0.4735], [1.1369, 0.4630],
      [-0.0938, 0.5728], [0.1533, 0.4054], [0.3363, 0.5000], [0.4167, 0.5377], [0.5000, 0.6250], [0.5476, 0.6991], [0.7887, 0.6118], [0.8378, 0.5880], [1.1563, 0.5608],
      [-0.0789, 0.7500], [0.2500, 0.5608], [0.3958, 0.5608], [0.4732, 0.6250], [0.5402, 0.7500], [0.5967, 0.7976], [0.8839, 0.7361], [0.8839, 0.7811], [1.1563, 0.6389],
      [-0.1057, 0.9226], [0.1250, 0.8750], [0.2976, 0.8750], [0.4464, 0.8882], [0.5908, 0.9041], [0.6250, 0.8750], [0.9702, 0.9041], [1.0268, 1.0000], [1.1726, 1.0443],
      [-0.0387, 1.1138], [0.0878, 1.1349], [0.2292, 1.1138], [0.4301, 1.1852], [0.6250, 1.2804], [0.6250, 1.3254], [1.0372, 1.2328], [0.9568, 1.2328], [1.0938, 1.2328],
  ],
  [  // case 4
      [-0.0952, -0.1561], [0.0997, -0.1561], [0.2396, -0.0847], [0.3586, -0.0608], [0.4926, -0.0608], [0.6086, -0.1561], [0.7426, -0.1772], [0.8616, -0.1561], [1.0640, -0.2275],
      [-0.0521, 0.0933], [-0.0521, 0.3062], [0.2708, 0.3750], [0.3750, 0.3485], [0.4926, 0.3062], [0.6250, 0.2335], [0.7500, 0.1250], [0.8750, -0.0337], [1.0640, -0.1772],
      [-0.1250, 0.3611], [0.0789, 0.5000], [0.2827, 0.4147], [0.3824, 0.3750], [0.4926, 0.3300], [0.6250, 0.2500], [0.7500, 0.1812], [0.8988, 0.0146], [1.0804, -0.1230],
      [-0.0952, 0.5119], [0.1518, 0.5344], [0.2827, 0.4683], [0.3824, 0.4147], [0.4926, 0.3750], [0.6250, 0.2851], [0.7589, 0.2163], [0.8988, 0.2335], [1.1190, 0.4147],
      [-0.0521, 0.6250], [0.2827, 0.5344], [0.2961, 0.5985], [0.3646, 0.5119], [0.4926, 0.3995], [0.6324, 0.3062], [0.7589, 0.2619], [0.9286, 0.3062], [1.1071, 0.4683],
      [-0.1399, 0.6938], [0.2902, 0.5721], [0.2604, 0.6759], [0.3586, 0.5344], [0.5000, 0.4286], [0.6414, 0.3300], [0.8006, 0.3062], [0.9673, 0.3750], [1.1190, 0.5985],
      [-0.0521, 0.7897], [0.1920, 0.8294], [0.2500, 0.7500], [0.2708, 0.6759], [0.5000, 0.5119], [0.7738, 0.5589], [0.8988, 0.7315], [0.9286, 0.7130], [1.1190, 0.7500],
      [-0.0685, 0.9438], [0.1518, 0.9438], [0.1979, 0.8750], [0.2500, 0.9570], [0.5000, 0.7718], [0.7738, 0.7315], [0.9360, 0.9755], [1.0000, 1.0205], [1.1726, 0.9570],
      [-0.0283, 1.0873], [0.0997, 1.1561], [0.1250, 1.1799], [0.2604, 1.1243], [0.4926, 1.0688], [0.8006, 1.0873], [0.9167, 1.1376], [1.0313, 1.2698], [1.1548, 1.3228],
  ],
];

// One quad-union level: insert edge midpoints and cell centres as plain
// averages, then relax with a separable binomial pass (lambda = 1/2) that pins
// only the four corners.
function _mgSubdivide(A) {
  const N = A.length;
  const M = 2 * N - 1;
  const B = Array.from({ length: M }, () => new Array(M));
  const avg = (...ps) => [0, 1].map(k => ps.reduce((sum, p) => sum + p[k], 0) / ps.length);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) B[2 * j][2 * i] = A[j][i].slice();
    for (let i = 0; i < N - 1; i++) B[2 * j][2 * i + 1] = avg(A[j][i], A[j][i + 1]);
  }
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N; i++) B[2 * j + 1][2 * i] = avg(A[j][i], A[j + 1][i]);
    for (let i = 0; i < N - 1; i++)
      B[2 * j + 1][2 * i + 1] = avg(A[j][i], A[j][i + 1], A[j + 1][i], A[j + 1][i + 1]);
  }
  const lam = 0.5;
  const C = B.map(r => r.map(p => p.slice()));
  for (let j = 0; j < M; j++)
    for (let i = 1; i < M - 1; i++)
      for (let k = 0; k < 2; k++)
        C[j][i][k] = B[j][i][k] + lam * (0.5 * (B[j][i - 1][k] + B[j][i + 1][k]) - B[j][i][k]);
  const D = C.map(r => r.map(p => p.slice()));
  for (let i = 0; i < M; i++)
    for (let j = 1; j < M - 1; j++)
      for (let k = 0; k < 2; k++)
        D[j][i][k] = C[j][i][k] + lam * (0.5 * (C[j - 1][i][k] + C[j + 1][i][k]) - C[j][i][k]);
  return D;
}

// The 33x33 `[x, y]` grid (lattice coordinates in [0, 1], row-major by j) for one
// field of one warp case: two subdivision levels from the 9x9 lattice.
function _mgFieldGrid(lattice) {
  let level = Array.from({ length: 9 }, (_, j) => lattice.slice(j * 9, j * 9 + 9));
  level = _mgSubdivide(_mgSubdivide(level));
  return level;
}

// Subdivided fields, built on first use: `from` is shared, `to` is per case.
let _mgFromGrid = null;
const _mgToGrids = [];

function _mgWarpGrids(caseIndex) {
  if (!_mgFromGrid) _mgFromGrid = _mgFieldGrid(_MG_WARP_FROM);
  if (!_mgToGrids[caseIndex]) _mgToGrids[caseIndex] = _mgFieldGrid(_MG_WARP_TO[caseIndex]);
  return { from: _mgFromGrid, to: _mgToGrids[caseIndex] };
}

class MGQuadUnionMesh {
  constructor(gl, attrPos, attrColor, attrUV, attrFrom, attrTo, warpCase) {
    this.gl = gl;
    this.attrPos = attrPos;
    this.attrColor = attrColor;
    this.attrUV = attrUV;
    this.attrFrom = attrFrom;
    this.attrTo = attrTo;
    this._warpCase = warpCase;
    this.cpW = 0;
    this.cpH = 0;
    this.cp = new Float32Array(0);
    this._uvData = new Float32Array(0);
    this._vertGl = gl.createBuffer();
    this._idxGl = gl.createBuffer();
    this._vertData = new Float32Array(0);
    this._idxData = new Uint16Array(0);
    this._wire = false;
    this._buildGeometry();
  }

  // Builds the 33x33 control grid for warp case `this._warpCase`. Vertex i
  // carries Apple's `from` and `to` positions for that case. The uv grid runs
  // u = i/32 and v = j/32, and the control frame has y = -(trace y).
  _buildGeometry() {
    const { from, to } = _mgWarpGrids(this._warpCase);
    const n = _MG_MESH_CONTROLS;
    this.cpW = n;
    this.cpH = n;
    this.cp = new Float32Array(n * n * 9);
    this._uvData = new Float32Array(n * n * 2);
    this._vertData = new Float32Array(n * n * _MG_MESH_FLOATS);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const index = i + j * n;
        const offset = index * 9;
        const fx = from[j][i][0] * 2 - 1;
        const fy = -(from[j][i][1] * 2 - 1);
        const tx = to[j][i][0] * 2 - 1;
        const ty = -(to[j][i][1] * 2 - 1);
        this.cp[offset] = fx;
        this.cp[offset + 1] = fy;
        this.cp[offset + 2] = 1;
        this.cp[offset + 3] = 1;
        this.cp[offset + 4] = 1;
        this.cp[offset + 5] = 0;
        this.cp[offset + 6] = 2 / (n - 1);
        this.cp[offset + 7] = 0;
        this.cp[offset + 8] = 2 / (n - 1);
        this._uvData[index * 2] = i / (n - 1);
        this._uvData[index * 2 + 1] = 1 - j / (n - 1);
        const vertex = index * _MG_MESH_FLOATS;
        this._vertData[vertex + 7] = fx;
        this._vertData[vertex + 8] = fy;
        this._vertData[vertex + 9] = tx;
        this._vertData[vertex + 10] = ty;
      }
    }
    this._buildIndices();
    this._rebuild();
  }

  resizeControlPoints() {
    // Fixed at 33x33 to match Apple's mesh. Kept for the public API surface.
  }

  resetSubdivition() {
    // Fixed at 33x33 to match Apple's mesh. Kept for the public API surface.
  }

  setWireFrame(on) {
    if (this._wire === !!on) return;
    this._wire = !!on;
    this._buildIndices();
  }

  // Which way a cell's diagonal runs. The trace's rule is stated in the uv
  // lattice, where v grows with the row index, while cp rows run the other way
  // (cp row y has v = 1 - ys[y]); `cpH - 1 - y` is the uv row, so the returned
  // parity is the captured one no matter how many control rows there are.
  _quadUnionSplit(x, y) {
    return ((x + this.cpH - 1 - y) & 1) === 0;
  }

  _buildIndices() {
    const cells = (this.cpW - 1) * (this.cpH - 1);
    const idx = new Uint16Array(cells * (this._wire ? 8 : 6));
    let k = 0;
    for (let y = 0; y < this.cpH - 1; y++) {
      for (let x = 0; x < this.cpW - 1; x++) {
        const a = y * this.cpW + x;
        const b = a + 1;
        const c = a + this.cpW;
        const d = c + 1;
        if (this._wire) {
          idx[k++] = a; idx[k++] = b;
          idx[k++] = b; idx[k++] = d;
          idx[k++] = d; idx[k++] = c;
          idx[k++] = c; idx[k++] = a;
        } else if (this._quadUnionSplit(x, y)) {
          // a-d ("\" in grid space). The captured Music mesh splits 512 cells
          // each way and leaves interior vertices at degree 8 or 4 (481 / 480);
          // a uniform split would put nearly all of them at degree 6.
          idx[k++] = a; idx[k++] = b; idx[k++] = d;
          idx[k++] = a; idx[k++] = d; idx[k++] = c;
        } else {
          idx[k++] = a; idx[k++] = b; idx[k++] = c;
          idx[k++] = b; idx[k++] = d; idx[k++] = c;
        }
      }
    }
    this._idxData = idx;
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this._idxGl);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, idx, this.gl.STATIC_DRAW);
  }

  setControlPoint(x, y, values) {
    const offset = (x + y * this.cpW) * 9;
    for (const [key, index] of Object.entries({
      x: 0, y: 1, r: 2, g: 3, b: 4,
      uAng: 5, uScale: 6, vAng: 7, vScale: 8,
    })) {
      if (values[key] !== undefined) this.cp[offset + index] = values[key];
    }
  }

  updateMesh() {
    this._rebuild();
  }

  controlPoint(x, y) {
    const mesh = this;
    const offset = (x + y * this.cpW) * 9;
    const fields = ['x', 'y', 'r', 'g', 'b', 'uAngle', 'uScale', 'vAngle', 'vScale'];
    const point = {};
    fields.forEach((field, index) => {
      Object.defineProperty(point, field, {
        get: () => mesh.cp[offset + index],
        set: value => { mesh.cp[offset + index] = value; },
        enumerable: true,
      });
    });
    return point;
  }

  _rebuild() {
    const vertices = this._vertData;
    for (let i = 0; i < this.cpW * this.cpH; i++) {
      const cp = i * 9;
      const vertex = i * _MG_MESH_FLOATS;
      vertices[vertex] = this.cp[cp];
      vertices[vertex + 1] = this.cp[cp + 1];
      vertices[vertex + 2] = this.cp[cp + 2];
      vertices[vertex + 3] = this.cp[cp + 3];
      vertices[vertex + 4] = this.cp[cp + 4];
      vertices[vertex + 5] = this._uvData[i * 2];
      vertices[vertex + 6] = this._uvData[i * 2 + 1];
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this._vertGl);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.DYNAMIC_DRAW);
  }

  draw() {
    const gl = this.gl;
    const stride = _MG_MESH_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertGl);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxGl);
    const bind = (attr, size, offset) => {
      if (attr === undefined || attr < 0) return;
      gl.vertexAttribPointer(attr, size, gl.FLOAT, false, stride, offset);
      gl.enableVertexAttribArray(attr);
    };
    bind(this.attrPos, 2, 0);
    bind(this.attrColor, 3, 8);
    bind(this.attrUV, 2, 20);
    bind(this.attrFrom, 2, 28);
    bind(this.attrTo, 2, 36);
    gl.drawElements(this._wire ? gl.LINES : gl.TRIANGLES, this._idxData.length, gl.UNSIGNED_SHORT, 0);
  }

  dispose() {
    if (this._vertGl) this.gl.deleteBuffer(this._vertGl);
    if (this._idxGl) this.gl.deleteBuffer(this._idxGl);
    this._vertGl = null;
    this._idxGl = null;
  }
}

class _MGTexture {
  constructor(gl, imageData) {
    this.gl = gl;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  bind() {
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
  }
  dispose() {
    this.gl.deleteTexture(this.tex);
  }
}



export default class dybg {
  constructor(canvas) {
    if (!canvas) throw new Error('dybg: canvas required');
    this._canvas = canvas;

    this._flowSpeed = 1;
    this._flowTarget = 1;
    this._renderScale = 0.5;
    this._blurScale = 1;
    this._staticMode = false;
    this._maxFPS = 60;
    this._paused = false;
    this._playing = true;
    this._playbackT = 1;
    // 1 = the captured `to` warp field, 0 = the flat `from` grid. Eased by
    // pause()/resume(), see `_updateFlat`.
    this._flatT = 1;
    this._breathAmount = 1;
    this._breathPeriod = _MG_BREATH_PERIOD;
    this._breathPos = 1;
    this._breathWarp = 1;
    this._breathWave = 0;
    this._breathPhase = Math.PI;
    this._breathFade = 0;
    this._manual = false;
    this._volume = 0;
    this._smoothVolume = 0;
    this._states = [];
    this._noCover = true;
    this._lastImage = null;
    this._requestId = 0;
    this._abort = null;
    this._disposed = false;
    this._contextLost = false;
    this._time = 0;
    this._lastFrame = 0;
    this._lastTick = 0;
    this._raf = 0;
    this._W = 0;
    this._H = 0;
    this._perfOn = false;
    this._fps = 0;
    this._fpsCount = 0;
    this._fpsStamp = 0;

    const gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) throw new Error('dybg: WebGL not supported');
    this._gl = gl;

    this._initGL();

    this._srcEl = null;
    this._layout = null;
    this._warpCase = null;
    this._layoutDirty = false;
    this._compAspect = 0;
    this._comp = document.createElement('canvas');
    this._compCtx = this._comp.getContext('2d', { willReadFrequently: true });

    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
    this._observer = new ResizeObserver(() => this._requestTick());
    this._observer.observe(canvas);

    this._requestTick();
  }

  _initGL() {
    const gl = this._gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float');
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);

    this._meshProg = _mgProgram(gl, _MGR_VERT, _MGR_FRAG, 'mesh');
    this._quadProg = _mgProgram(gl, _MGR_QUAD_VERT, _MGR_QUAD_FRAG, 'quad');
    this._meshUni = {};
    for (const n of [
      'u_aspect', 'u_texture', 'u_volume', 'u_alpha', 'u_sinAngle', 'u_cosAngle',
      'u_time', 'u_motion', 'u_breath', 'u_breathPhase',
      'u_breathPosition', 'u_breathWarp', 'u_breathWave',
      'u_warpMix', 'u_transitionMix',
    ]) {
      this._meshUni[n] = gl.getUniformLocation(this._meshProg.prog, n);
    }
    this._quadUni = {};
    for (const n of ['u_texture', 'u_alpha']) {
      this._quadUni[n] = gl.getUniformLocation(this._quadProg.prog, n);
    }

    this._tri = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this._fboTex = null;
    this._fbo = null;
  }

  _onLost = (event) => {
    event.preventDefault();
    this._contextLost = true;
    if (this._abort) this._abort.abort();
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  };

  _onRestored = () => {
    if (this._disposed) return;
    this._contextLost = false;
    this._states = [];
    this._W = 0;
    this._H = 0;
    this._initGL();
    if (this._lastImage) this._states.push(this._makeState(this._lastImage));
    this._requestTick();
  };

  _checkSize() {
    const c = this._canvas;
    const dpr = window.devicePixelRatio || 1;
    const vw = c.clientWidth || window.innerWidth;
    const vh = c.clientHeight || window.innerHeight;
    const aspect = vw / Math.max(1, vh);
    if (this._srcEl && this._compAspect && Math.abs(aspect - this._compAspect) > 0.02) {
      this._layoutDirty = true;
    }
    const w = Math.max(1, Math.round(c.clientWidth * dpr * this._renderScale));
    const h = Math.max(1, Math.round(c.clientHeight * dpr * this._renderScale));
    if (w === this._W && h === this._H) return;
    this._W = w;
    this._H = h;
    c.width = w;
    c.height = h;
    if (this._fboTex) this._gl.deleteTexture(this._fboTex);
    if (this._fbo) this._gl.deleteFramebuffer(this._fbo);
    const gl = this._gl;
    this._fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this._fboTex,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _makeState(imageData) {
    const gl = this._gl;
    // Pick the warp case once and keep it, so later tracks (and a restored
    // context) get the same geometry and only the artwork changes.
    if (this._warpCase === null) {
      this._warpCase = Math.floor(Math.random() * _MG_WARP_TO.length);
    }
    const mesh = new MGQuadUnionMesh(
      gl,
      this._meshProg.attrs.a_pos,
      this._meshProg.attrs.a_color,
      this._meshProg.attrs.a_uv,
      this._meshProg.attrs.a_from,
      this._meshProg.attrs.a_to,
      this._warpCase,
    );
    return {
      mesh,
      texture: new _MGTexture(gl, imageData),
      alpha: 0,
    };
  }

  _boxBlur(imageData, radius, iterations, wrap) {
    const { data, width, height } = imageData;
    const rad = Math.max(1, Math.round(radius));
    const src = new Float32Array(data.length);
    const tmp = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) src[i] = data[i];
    const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wrapN = wrap ? (v, n) => ((v % n) + n) % n : null;
    const idx = wrapN ? (v, n) => wrapN(v, n) : (v, n) => clampN(v, 0, n - 1);
    const cap = (v, n) => clampN(v, 0, n - 1);

    for (let it = 0; it < iterations; it++) {

      for (let y = 0; y < height; y++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        const row = y * width;
        for (let k = -rad; k <= rad; k++) {
          const x = idx(k, width);
          const o = (row + x) * 4;
          r += src[o];
          g += src[o + 1];
          b += src[o + 2];
          a += src[o + 3];
        }
        const n = 2 * rad + 1;
        for (let x = 0; x < width; x++) {
          const o = (row + x) * 4;
          tmp[o] = r / n;
          tmp[o + 1] = g / n;
          tmp[o + 2] = b / n;
          tmp[o + 3] = a / n;
          const oOut = (row + idx(x + rad + 1, width)) * 4;
          const oIn = (row + idx(x - rad, width)) * 4;
          r += src[oOut] - src[oIn];
          g += src[oOut + 1] - src[oIn + 1];
          b += src[oOut + 2] - src[oIn + 2];
          a += src[oOut + 3] - src[oIn + 3];
        }
      }

      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let k = -rad; k <= rad; k++) {
          const y = idx(k, height);
          const o = (y * width + x) * 4;
          r += tmp[o];
          g += tmp[o + 1];
          b += tmp[o + 2];
          a += tmp[o + 3];
        }
        const n = 2 * rad + 1;
        for (let y = 0; y < height; y++) {
          const o = (y * width + x) * 4;
          src[o] = r / n;
          src[o + 1] = g / n;
          src[o + 2] = b / n;
          src[o + 3] = a / n;
          const ok1 = idx(y + rad + 1, height);
          const ok2 = idx(y - rad, height);
          const oOut = (ok1 * width + x) * 4;
          const oIn = (ok2 * width + x) * 4;
          r += tmp[oOut] - tmp[oIn];
          g += tmp[oOut + 1] - tmp[oIn + 1];
          b += tmp[oOut + 2] - tmp[oIn + 2];
          a += tmp[oOut + 3] - tmp[oIn + 3];
        }
      }
    }
    for (let i = 0; i < data.length; i++) data[i] = src[i];
  }

  _rand(min, max) {
    return min + Math.random() * (max - min);
  }

  _randomizeLayout() {
    // 4 clones max, all large. frac is relative to min(w, h).
    const fracs = [
      this._rand(0.95, 1.15),
      this._rand(0.80, 0.95),
      this._rand(0.70, 0.85),
      this._rand(0.60, 0.75),
    ];
    this._layout = {
      zoom: this._rand(1.15, 1.35),
      panX: this._rand(-0.06, 0.06),
      panY: this._rand(-0.06, 0.06),
      clones: fracs.map((frac, i) => ({
        frac,
        x: i === 0 ? this._rand(0.4, 0.6) : this._rand(0.2, 0.8),
        y: i === 0 ? this._rand(0.4, 0.6) : this._rand(0.2, 0.8),
        rot: i === 0 ? this._rand(-0.5, 0.5) : this._rand(-Math.PI, Math.PI),
      })),
    };
  }

  _srcSize(src) {
    if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
    if (src instanceof ImageBitmap || src instanceof HTMLCanvasElement) return [src.width, src.height];
    return [src.naturalWidth || src.width || 0, src.naturalHeight || src.height || 0];
  }

  _drawClone(ctx, src, iw, ih, cx, cy, size, rot, cover) {
    const scale = cover ? Math.max(size / iw, size / ih) : Math.min(size / iw, size / ih);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.drawImage(src, (-iw * scale) / 2, (-ih * scale) / 2, iw * scale, ih * scale);
    ctx.restore();
  }

  _composeArtwork(src) {
    const [iw, ih] = this._srcSize(src);
    if (!iw || !ih) return null;

    const c = this._comp;
    const vw = this._canvas.clientWidth || window.innerWidth;
    const vh = this._canvas.clientHeight || window.innerHeight;
    const aspect = vw / Math.max(1, vh);
    const w = Math.round(aspect >= 1 ? _MG_COMP_LONG : _MG_COMP_LONG * aspect);
    const h = Math.round(aspect >= 1 ? _MG_COMP_LONG / aspect : _MG_COMP_LONG);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this._compAspect = aspect;

    if (!this._layout) this._randomizeLayout();
    const L = this._layout;
    L.aspect = aspect;
    const ctx = this._compCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.filter = 'saturate(1.4) contrast(1.05)';
    this._drawClone(
      ctx, src, iw, ih,
      w / 2 + L.panX * w,
      h / 2 + L.panY * h,
      Math.max(w, h) * L.zoom,
      0,
      true,
    );
    ctx.filter = 'none';

    const bg = ctx.getImageData(0, 0, w, h);
    const long = Math.max(w, h);
    const bs = this._blurScale;
    const bgRad = Math.round(Math.max(4, long * 0.14) * bs);
    if (bgRad >= 1) {
      this._boxBlur(bg, bgRad, 3, false);
      ctx.putImageData(bg, 0, 0);
    }

    ctx.filter = 'saturate(1.4) contrast(1.05)';
    const unit = Math.min(w, h);
    for (const cl of L.clones) {
      this._drawClone(ctx, src, iw, ih, cl.x * w, cl.y * h, cl.frac * unit, cl.rot, false);
    }
    ctx.filter = 'none';

    const imageData = ctx.getImageData(0, 0, w, h);
    const fgRad = Math.round(Math.max(2, long * 0.055) * bs);
    if (fgRad >= 1) this._boxBlur(imageData, fgRad, 4, false);
    return imageData;
  }

  _recompose() {
    if (!this._srcEl || !this._states.length) return;
    const imageData = this._composeArtwork(this._srcEl);
    if (!imageData) return;
    const s = this._states[this._states.length - 1];
    s.texture.dispose();
    s.texture = new _MGTexture(this._gl, imageData);
    this._lastImage = imageData;
    this._requestTick();
  }

  _loadRemote(url, isVideo, ctrl) {
    return new Promise((resolve) => {
      const loadViaElement = () => {
        const el = isVideo ? document.createElement('video') : new Image();
        el.crossOrigin = 'anonymous';
        const onOk = () => resolve(el);
        const onFail = () => resolve(null);
        el.addEventListener(isVideo ? 'loadeddata' : 'load', onOk, {
          once: true,
        });
        el.addEventListener('error', onFail, { once: true });
        if (isVideo) {
          el.muted = true;
          el.playsInline = true;
        }
        el.src = url;
        if (isVideo) el.play().catch(() => { });
      };
      if (isVideo || /^blob:/i.test(url)) {
        loadViaElement();
      } else if (typeof createImageBitmap === 'function') {
        fetch(url, { signal: ctrl.signal })
          .then((resp) =>
            resp.ok ? resp.blob() : Promise.reject(new Error('bad status')),
          )
          .then((blob) => createImageBitmap(blob))
          .then((bitmap) => resolve(bitmap))
          .catch(() => loadViaElement());
      } else {
        loadViaElement();
      }
    });
  }

  async setAlbum(source, isVideo) {
    const myId = ++this._requestId;
    if (this._abort) this._abort.abort();
    const ctrl = new AbortController();
    this._abort = ctrl;

    const empty =
      source === undefined ||
      (typeof source === 'string' && source.trim().length === 0);
    if (empty) {
      this._noCover = true;
      this._lastImage = null;
      this._srcEl = null;
      return;
    }

    let src = null;
    try {
      if (typeof source === 'string') {

        for (let i = 0; i < 3 && src === null; i++) {
          const res = await this._loadRemote(source, isVideo, ctrl);
          if (res) {
            src = res;
            break;
          }
        }
        if (!src) return;
      } else {
        src = source;
      }
    } catch (e) {
      if (ctrl.signal.aborted || myId !== this._requestId) return;
      console.warn('dybg: load failed', e);
      return;
    }
    if (myId !== this._requestId) return;

    this._srcEl = src;
    // Keep the existing layout across tracks; only the first track rolls one.
    if (!this._layout) this._randomizeLayout();
    const imageData = this._composeArtwork(src);
    if (!imageData) return;
    if (myId !== this._requestId) return;

    if (this._manual && this._states.length > 0) {
      this._states[0].texture.dispose();
      this._states[0].texture = new _MGTexture(this._gl, imageData);
    } else {
      this._states.push(this._makeState(imageData));
    }
    this._noCover = false;
    this._lastImage = imageData;
    this._requestTick();
  }

  _frame(now, dt) {
    const gl = this._gl;
    this._checkSize();
    if (!this._W || !this._H) return true;
    if (this._layoutDirty) {
      this._layoutDirty = false;
      this._recompose();
    }

    const deltaFactor = dt / 500;
    const latest = this._states[this._states.length - 1];
    let canBeStatic = false;

    if (latest) {
      if (this._manual) latest.mesh.updateMesh();
      if (this._noCover) {
        let active = false;
        for (let i = this._states.length - 1; i >= 0; i--) {
          const s = this._states[i];
          s.alpha -= deltaFactor;
          if (s.alpha <= -0.1) {
            s.mesh.dispose();
            s.texture.dispose();
            this._states.splice(i, 1);
          } else {
            active = true;
          }
        }
        canBeStatic = !active;
      } else {
        latest.alpha = Math.min(1.1, latest.alpha + deltaFactor);
        if (latest.alpha >= 1.1) {
          const dead = this._states.splice(0, this._states.length - 1);
          for (const s of dead) {
            s.mesh.dispose();
            s.texture.dispose();
          }
        }
        canBeStatic = this._states.length === 1 && latest.alpha >= 1.1;
      }
    }

    this._smoothVolume +=
      (this._volume - this._smoothVolume) * Math.min(1, dt / 100);

    const aspect = this._manual ? 1 : this._W / this._H;
    const angle = (Math.min(now, 1e9) / 10000 + this._volume) * 2.0;
    const sinA = Math.sin(angle);
    const cosA = Math.cos(angle);

    gl.viewport(0, 0, this._W, this._H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (const s of this._states) {

      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this._meshProg.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(this._meshUni.u_aspect, aspect);
      gl.uniform1i(this._meshUni.u_texture, 0);
      gl.uniform1f(this._meshUni.u_volume, this._volume);
      gl.uniform1f(this._meshUni.u_alpha, 1.0);
      gl.uniform1f(this._meshUni.u_sinAngle, sinA);
      gl.uniform1f(this._meshUni.u_cosAngle, cosA);
      gl.uniform1f(this._meshUni.u_time, this._time);
      gl.uniform1f(this._meshUni.u_motion, this._manual ? 0 : this._playbackT);
      gl.uniform1f(
        this._meshUni.u_breath,
        this._manual ? 0 : this._breathAmount * this._breathFade,
      );
      gl.uniform1f(this._meshUni.u_breathPhase, this._breathPhase);
      gl.uniform1f(this._meshUni.u_breathPosition, this._breathPos);
      gl.uniform1f(this._meshUni.u_breathWarp, this._breathWarp);
      gl.uniform1f(this._meshUni.u_breathWave, this._breathWave);
      // warpMix stays at 1: the mesh always runs the from/to branch, and the
      // `to` field's own animation is the flow/breathing above.
      //
      // transitionMix is what pause() drives: it eases 1 -> 0 over
      // _MG_PLAYBACK_MS so the mesh flattens onto the upright `from` grid
      // instead of freezing with its control-point warp still out, and back to
      // 1 on resume. The from/to pair is the before/after of Apple's album-art
      // card flip, not two poses of a resting warp: from is the upright grid
      // (2u-1, 1-2v) to within 0.0069, to a fold-free warp of it with
      // corr(from.y, to.y) = +0.929 over all 1,089 captured vertices. Walking
      // through the near-flat state is exactly what pausing asks for here, and
      // it must still never ride the fade-in.
      gl.uniform1f(this._meshUni.u_warpMix, 1.0);
      gl.uniform1f(this._meshUni.u_transitionMix, _MG_EASE(this._flatT));
      s.texture.bind();
      s.mesh.draw();


      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      );
      gl.useProgram(this._quadProg.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._fboTex);
      gl.uniform1i(this._quadUni.u_texture, 0);
      gl.uniform1f(this._quadUni.u_alpha, _MGR_EASE(_MGR_CLAMP01(s.alpha)));
      gl.bindBuffer(gl.ARRAY_BUFFER, this._tri);
      gl.vertexAttribPointer(this._quadProg.attrs.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(this._quadProg.attrs.a_pos);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(this._quadProg.attrs.a_pos);
    }

    gl.flush();
    return canBeStatic && !this._breathRunning() && this._flatSettled();
  }

  // True once the mesh has finished flattening or un-flattening.
  _flatSettled() {
    return this._flatT === (this._playing ? 1 : 0);
  }

  _updatePlayback(dt) {
    if (this._manual || !this._states.length) return;
    const target = this._playing ? 1 : 0;
    if (target === this._playbackT) {
      this._flowSpeed = target ? this._flowTarget : 0;
      return;
    }
    const direction = target > this._playbackT ? 1 : -1;
    this._playbackT = Math.max(
      0,
      Math.min(1, this._playbackT + (direction * dt) / _MG_PLAYBACK_MS),
    );
    const eased = _MG_EASE(this._playbackT);
    this._flowSpeed = this._flowTarget * eased;
    if (this._playbackT === 1) this._breathFade = 0;
  }

  // Eases the mesh between the warped `to` field and the flat `from` grid,
  // on the same ramp as the playback fade so both settle on the same frame.
  _updateFlat(dt) {
    const target = this._playing ? 1 : 0;
    if (this._flatT === target) return;
    const direction = target > this._flatT ? 1 : -1;
    this._flatT = Math.max(
      0,
      Math.min(1, this._flatT + (direction * dt) / _MG_PLAYBACK_MS),
    );
  }

  _breathe(dt) {
    if (!this._breathRunning()) return;
    this._breathPhase =
      (this._breathPhase + (_MG_TAU * dt) / this._breathPeriod) % _MG_TAU;
    this._breathFade = Math.min(1, this._breathFade + dt / _MG_BREATH_FADE);
  }

  _breathRunning() {
    return (
      this._breathAmount > 0 &&
      !this._manual &&
      this._playbackT === 1 &&
      this._states.length > 0
    );
  }

  _tick = (now) => {
    this._raf = 0;
    if (this._paused || this._disposed || this._contextLost) return;

    if (this._perfOn) {
      this._fpsCount++;
      if (now - this._fpsStamp > 1000) {
        this._fps = this._fpsCount;
        this._fpsCount = 0;
        this._fpsStamp = now;
      }
    }

    const limit = this._maxFPS > 0 ? this._maxFPS : 60;
    const interval = 1000 / limit;
    const tickDelta = now - this._lastTick;
    if (tickDelta > 0 && tickDelta < interval) {
      this._requestTick();
      return;
    }
    this._lastTick = now - (tickDelta % interval);

    if (!this._lastFrame) this._lastFrame = now;
    const rawDt = now - this._lastFrame;
    const dt = rawDt > 0 ? Math.min(rawDt, 200) : interval;
    this._lastFrame = now;
    this._updatePlayback(dt);
    this._updateFlat(dt);
    this._breathe(dt);
    this._time += dt * this._flowSpeed;

    const staticOk = this._frame(this._time, dt);
    if (!staticOk || !this._staticMode) {
      this._requestTick();
    } else {
      this._lastFrame = 0;
    }
  };

  _requestTick() {
    if (this._disposed || this._contextLost || this._raf) return;
    this._raf = requestAnimationFrame(this._tick);
  }

  setFlowSpeed(speed) {
    this._flowTarget = speed;
    if (this._playing) this._flowSpeed = speed;
  }

  setRenderScale(scale) {
    this._renderScale = scale;
    this._requestTick();
  }

  setBlur(scale) {
    const v = Math.max(0, Math.min(3, Number(scale) || 0));
    if (v === this._blurScale) return;
    this._blurScale = v;
    this._recompose();
  }

  // Controls the GPU-driven breathing layered over the flowing quad union.
  setBreathing(amount, options = {}) {
    const raw = amount === undefined ? this._breathAmount : Number(amount);
    const previous = this._breathAmount;
    this._breathAmount = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 1));
    if (previous <= 0 && this._breathAmount > 0) this._breathFade = 0;

    const clamp = (value, lo, hi, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
    };
    this._breathPeriod = clamp(options.period, 1200, 120000, this._breathPeriod);
    this._breathPos = clamp(options.position, 0, 1, this._breathPos);
    this._breathWarp = clamp(options.warp, 0, 1, this._breathWarp);
    this._breathWave = clamp(options.wave, 0, _MG_TAU, this._breathWave);

    this._requestTick();
  }

  setStaticMode(enable) {
    this._staticMode = !!enable;
    this._lastFrame = performance.now();
    this._requestTick();
  }

  setFPS(fps) {
    this._maxFPS = fps;
    if (fps <= 0 && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else {
      this._requestTick();
    }
  }

  pause() {
    if (!this._playing) return;
    this._playing = false;
    this._requestTick();
  }

  resume() {
    if (this._playing) return;
    this._playing = true;
    this._lastFrame = 0;
    this._requestTick();
  }

  play() {
    this.resume();
  }

  setLowFreqVolume(volume) {
    this._volume = volume / 10;
  }

  setHasLyric() { }

  setManualControl(enable) {
    const was = this._manual;
    this._manual = !!enable;
    if (this._manual !== was) this._breathFade = 0;
    this._requestTick();
  }

  setWireFrame(enable) {
    for (const s of this._states) s.mesh.setWireFrame(enable);
  }

  // The mesh is Apple's fixed 33x33 grid, so resizing and subdivision are no-ops.
  resizeControlPoints() { }

  resetSubdivition() { }

  getControlPoint(x, y) {
    const s = this._states[this._states.length - 1];
    return s ? s.mesh.controlPoint(x, y) : undefined;
  }

  setControlPoint(cx, cy, vals) {
    const s = this._states[this._states.length - 1];
    if (!s) return;
    s.mesh.setControlPoint(cx, cy, vals);
    if (!this._manual) s.mesh.updateMesh();
    this._requestTick();
  }

  randomize() {
    const s = this._states[this._states.length - 1];
    if (this._srcEl && s) {
      this._randomizeLayout();
      this._recompose();
    }
    if (s) this._requestTick();
  }

  enablePerformanceMonitor(enable) {
    this._perfOn = !!enable;
    if (enable) {
      this._fpsCount = 0;
      this._fpsStamp = performance.now();
    }
  }

  getCurrentFPS() {
    return this._fps;
  }

  getElement() {
    return this._canvas;
  }

  setAlbumImage(source) {
    return this.setAlbum(source);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._abort) this._abort.abort();
    this._observer.disconnect();
    this._canvas.removeEventListener('webglcontextlost', this._onLost);
    this._canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    const gl = this._gl;
    for (const s of this._states) {
      s.mesh.dispose();
      s.texture.dispose();
    }
    this._states = [];
    gl.deleteProgram(this._meshProg.prog);
    gl.deleteProgram(this._quadProg.prog);
    gl.deleteBuffer(this._tri);
    if (this._fboTex) gl.deleteTexture(this._fboTex);
    if (this._fbo) gl.deleteFramebuffer(this._fbo);
  }
}


export { dybg as MeshGradientRenderer };