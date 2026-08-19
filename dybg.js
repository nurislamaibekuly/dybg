




export class MeshGradient {
  constructor(options = {}) {
    const {
      container   = document.body,
      colors      = ['#cc1122','#00cccc','#880022','#004444','#ee2244','#0099aa'],
      background  = '#050506',
      numBlobs    = 8,
      blur        = 110,
      speed       = 0.18,
      saturation  = 2.5,
      contrast    = 1.08,
      brightness  = 0.78,
    } = options;

    this._colors     = colors.map(c => this._hexToRgb(c));
    this._bgRgb      = this._hexToRgb(background);
    this._numBlobs   = numBlobs;
    this._blurPx     = blur;
    this._speed      = speed;
    this._saturation = saturation;
    this._contrast   = contrast;
    this._brightness = brightness;
    this._animId     = null;
    this._startTime  = 0;
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

    
    try { this._gl = this._canvas.getContext('webgl', { alpha: false, antialias: false }); } catch(_){}
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
    const h = hex.replace('#','');
    const n = parseInt(h.length === 3
      ? h.split('').map(c=>c+c).join('')
      : h, 16);
    return [(n>>16&255)/255, (n>>8&255)/255, (n&255)/255];
  }

  _initBlobs() {
    const blobs = [];
    for (let i = 0; i < this._numBlobs; i++) {
      blobs.push({
        x:      Math.random(),
        y:      Math.random(),
        vx:     (Math.random() - 0.5) * 0.0003,
        vy:     (Math.random() - 0.5) * 0.0003,
        
        px:     Math.random() * Math.PI * 2,
        py:     Math.random() * Math.PI * 2,
        fx:     0.15 + Math.random() * 0.25,  
        fy:     0.12 + Math.random() * 0.22,  
        ax:     0.08 + Math.random() * 0.18,  
        ay:     0.06 + Math.random() * 0.16,  
        cx:     0.1 + Math.random() * 0.8,    
        cy:     0.1 + Math.random() * 0.8,    
        size:   0.3 + Math.random() * 0.55,   
        weight: 0.6 + Math.random() * 1.2,    
        ci:     i % this._colors.length,       
      });
    }
    return blobs;
  }

  _resize() {
    this._W = this._root.clientWidth  || window.innerWidth;
    this._H = this._root.clientHeight || window.innerHeight;
    this._canvas.width  = this._W;
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
    const n  = this._numBlobs;

    
    this._buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);

    
    this._blobProg = this._createProgram(this._vsSrc(), this._blobFsSrc(n));
    gl.useProgram(this._blobProg);
    const blobPos = gl.getAttribLocation(this._blobProg, 'a_pos');
    gl.enableVertexAttribArray(blobPos);
    gl.vertexAttribPointer(blobPos, 2, gl.FLOAT, false, 0, 0);
    this._uAspect   = gl.getUniformLocation(this._blobProg, 'u_aspect');
    this._uBg       = gl.getUniformLocation(this._blobProg, 'u_bg');
    this._uColors   = [];
    this._uPos      = [];
    this._uSize     = [];
    this._uWeight   = [];
    for (let i = 0; i < n; i++) {
      this._uColors.push(gl.getUniformLocation(this._blobProg, `u_colors[${i}]`));
      this._uPos.push(   gl.getUniformLocation(this._blobProg, `u_pos[${i}]`));
      this._uSize.push(  gl.getUniformLocation(this._blobProg, `u_size[${i}]`));
      this._uWeight.push(gl.getUniformLocation(this._blobProg, `u_weight[${i}]`));
    }

    
    this._kawaseProg = this._createProgram(this._vsSrc(), this._kawaseFsSrc());
    gl.useProgram(this._kawaseProg);
    const kPos = gl.getAttribLocation(this._kawaseProg, 'a_pos');
    gl.enableVertexAttribArray(kPos);
    gl.vertexAttribPointer(kPos, 2, gl.FLOAT, false, 0, 0);
    this._kTex    = gl.getUniformLocation(this._kawaseProg, 'u_tex');
    this._kTexel  = gl.getUniformLocation(this._kawaseProg, 'u_texel');
    this._kIter   = gl.getUniformLocation(this._kawaseProg, 'u_iter');
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
    const t  = gl.createTexture();
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
    this._fboA    = this._mkFBO(this._fboATex, this._fboW, this._fboH);
    this._fboBTex = this._mkTex(this._fboW, this._fboH);
    this._fboB    = this._mkFBO(this._fboBTex, this._fboW, this._fboH);
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
    const n  = this._numBlobs;
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
      gl.uniform2f(this._uPos[i],   b.x, b.y);
      gl.uniform1f(this._uSize[i],  b.size);
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
    ctx.fillStyle = `rgb(${Math.round(bg[0]*255)},${Math.round(bg[1]*255)},${Math.round(bg[2]*255)})`;
    ctx.fillRect(0, 0, W, H);
    for (const b of this._blobs) {
      const c = this._colors[b.ci];
      const x = b.x * W, y = b.y * H;
      const r = b.size * Math.max(W, H) * 0.6;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)},0.8)`);
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
    else          this._render2D(t);
    this._animId = requestAnimationFrame(ts => this._loop(ts));
  }

  

  get blur()  { return this._blurPx; }
  set blur(v) { this._blurPx = Math.max(0, Math.min(200, v)); }

  get speed()  { return this._speed; }
  set speed(v) { this._speed = v; }

  get saturation()  { return this._saturation; }
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
const _MGR_TEX_SIZE = 32;
const _MG_PLAYBACK_MS = 1000;
const _MG_EASE = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const _MG_FLAT_GRID = (w, h) => {
  const v = new Float32Array(w * h * 9);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (i + j * w) * 9;
      v[o] = (i / (w - 1)) * 2 - 1;
      v[o + 1] = (j / (h - 1)) * 2 - 1;
      v[o + 2] = 1;
      v[o + 3] = 1;
      v[o + 4] = 1;
      v[o + 5] = 0;
      v[o + 6] = 2 / (w - 1);
      v[o + 7] = 0;
      v[o + 8] = 2 / (h - 1);
    }
  }
  return v;
};



const _MGR_HERMITE = [
  2, -2, 1, 1,
  -3, 3, -2, -1,
  0, 0, 1, 0,
  1, 0, 0, 0,
];


const _MGR_VERT = `
precision mediump float;
attribute vec2 a_pos;
attribute vec3 a_color;
attribute vec2 a_uv;
varying vec3 v_color;
varying vec2 v_uv;
uniform float u_aspect;
void main(){
  v_color = a_color;
  v_uv = a_uv;
  vec2 pos = a_pos;
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
  vec2 centeredUV = v_uv - vec2(0.2);
  vec2 rotatedUV = vec2(
    u_cosAngle * centeredUV.x - u_sinAngle * centeredUV.y,
    u_sinAngle * centeredUV.x + u_cosAngle * centeredUV.y
  );
  vec2 finalUV = rotatedUV * max(0.001, 1.0 - volumeEffect) + vec2(0.5);
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



class MGHermiteMesh {
  constructor(gl, attrPos, attrColor, attrUV) {
    this.gl = gl;
    this.attrPos = attrPos;
    this.attrColor = attrColor;
    this.attrUV = attrUV;
    this.cpW = 2;
    this.cpH = 2;
    this.sub = 40;
    this.cp = new Float32Array(0); 
    this.gW = 0;
    this.gH = 0;
    this._vertGl = gl.createBuffer();
    this._idxGl = gl.createBuffer();
    this._vertData = new Float32Array(0);
    this._idxData = new Uint16Array(0);
    this._wire = false;
    this.resizeControlPoints(2, 2);
    this._rebuild();
  }

  resizeControlPoints(width, height) {
    const w = Math.max(2, width | 0);
    const h = Math.max(2, height | 0);
    this.cpW = w;
    this.cpH = h;
    const flat = new Float32Array(w * h * 9);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = (i + j * w) * 9;
        flat[o] = (i / (w - 1)) * 2 - 1;
        flat[o + 1] = (j / (h - 1)) * 2 - 1;
        flat[o + 2] = 1;
        flat[o + 3] = 1;
        flat[o + 4] = 1;
        flat[o + 5] = 0;
        flat[o + 6] = 2 / (w - 1);
        flat[o + 7] = 0;
        flat[o + 8] = 2 / (h - 1);
      }
    }
    this.cp = flat;
    this._sizeBuffers();
  }

  resetSubdivition(sub) {
    this.sub = Math.max(2, sub | 0);
    this._sizeBuffers();
  }

  setWireFrame(on) {
    if (this._wire === !!on) return;
    this._wire = !!on;
    this._buildIndices();
  }

  _sizeBuffers() {
    let sub = this.sub;
    let w = (this.cpW - 1) * sub;
    let h = (this.cpH - 1) * sub;
    
    if (w * h > 65000) {
      sub = Math.max(
        2,
        Math.floor(Math.sqrt(65000 / Math.max(1, (this.cpW - 1) * (this.cpH - 1)))),
      );
      w = (this.cpW - 1) * sub;
      h = (this.cpH - 1) * sub;
      this.sub = sub;
    }
    this.gW = w;
    this.gH = h;
    this._vertData = new Float32Array(w * h * 7);
    this._buildIndices();
  }

  _buildIndices() {
    const gl = this.gl;
    const w = this.gW;
    const h = this.gH;
    const step = this._wire ? 10 : 6;
    const idx = new Uint16Array((w - 1) * (h - 1) * step);
    let k = 0;
    for (let j = 0; j < h - 1; j++) {
      for (let i = 0; i < w - 1; i++) {
        const a = j * w + i;
        const b = a + 1;
        const c = a + w;
        const d = c + 1;
        if (this._wire) {
          idx[k++] = a; idx[k++] = b;
          idx[k++] = b; idx[k++] = c;
          idx[k++] = c; idx[k++] = d;
          idx[k++] = d; idx[k++] = a;
          idx[k++] = a; idx[k++] = c;
        } else {
          idx[k++] = a; idx[k++] = b; idx[k++] = c;
          idx[k++] = b; idx[k++] = d; idx[k++] = c;
        }
      }
    }
    this._idxData = idx;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxGl);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  setControlPoint(cx, cy, v) {
    const o = (cx + cy * this.cpW) * 9;
    const cp = this.cp;
    if (v.x !== undefined) cp[o] = v.x;
    if (v.y !== undefined) cp[o + 1] = v.y;
    if (v.r !== undefined) cp[o + 2] = v.r;
    if (v.g !== undefined) cp[o + 3] = v.g;
    if (v.b !== undefined) cp[o + 4] = v.b;
    if (v.uAng !== undefined) cp[o + 5] = v.uAng;
    if (v.uScale !== undefined) cp[o + 6] = v.uScale;
    if (v.vAng !== undefined) cp[o + 7] = v.vAng;
    if (v.vScale !== undefined) cp[o + 8] = v.vScale;
  }

  updateMesh() {
    this._rebuild();
  }

  
  controlPoint(cx, cy) {
    const mesh = this;
    const o = (cx + cy * this.cpW) * 9;
    return {
      get x() { return mesh.cp[o]; },
      set x(v) { mesh.cp[o] = v; },
      get y() { return mesh.cp[o + 1]; },
      set y(v) { mesh.cp[o + 1] = v; },
      get r() { return mesh.cp[o + 2]; },
      set r(v) { mesh.cp[o + 2] = v; },
      get g() { return mesh.cp[o + 3]; },
      set g(v) { mesh.cp[o + 3] = v; },
      get b() { return mesh.cp[o + 4]; },
      set b(v) { mesh.cp[o + 4] = v; },
      get uAngle() { return mesh.cp[o + 5]; },
      set uAngle(v) { mesh.cp[o + 5] = v; },
      get uScale() { return mesh.cp[o + 6]; },
      set uScale(v) { mesh.cp[o + 6] = v; },
      get vAngle() { return mesh.cp[o + 7]; },
      set vAngle(v) { mesh.cp[o + 7] = v; },
      get vScale() { return mesh.cp[o + 8]; },
      set vScale(v) { mesh.cp[o + 8] = v; },
    };
  }

  _readCp(cx, cy, out) {
    const o = (cx + cy * this.cpW) * 9;
    const cp = this.cp;
    out.vx = cp[o];
    out.vy = cp[o + 1];
    out.r = cp[o + 2];
    out.g = cp[o + 3];
    out.b = cp[o + 4];
    const ua = cp[o + 5];
    const us = cp[o + 6];
    const va = cp[o + 7];
    const vs = cp[o + 8];
    out.ux = Math.cos(ua) * us;
    out.uy = Math.sin(ua) * us;
    out.wx = -Math.sin(va) * vs;
    out.wy = Math.cos(va) * vs;
  }

  
  _hp4mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b0 + a[r + 4] * b1 + a[r + 8] * b2 + a[r + 12] * b3;
      }
    }
    return o;
  }

  _hp4t(m) {
    const t = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) t[c * 4 + r] = m[r * 4 + c];
    }
    return t;
  }

  
  
  _rebuild() {
    const gl = this.gl;
    const W = this.cpW;
    const H = this.cpH;
    const sub = this.sub;
    const subM1 = sub - 1;
    const tW = subM1 * (H - 1);
    const tH = subM1 * (W - 1);
    const invTW = 1 / tW;
    const invTH = 1 / tH;
    const gW = this.gW;
    const gH = this.gH;
    const vd = this._vertData;

    const bl = { vx: 0, vy: 0, r: 0, g: 0, b: 0, ux: 0, uy: 0, wx: 0, wy: 0 };
    const br = Object.assign({}, bl);
    const tl = Object.assign({}, bl);
    const tr = Object.assign({}, bl);

    
    const P = new Float32Array(sub * 4);
    for (let i = 0; i < sub; i++) {
      const t = i / subM1;
      const o = i * 4;
      P[o] = t * t * t;
      P[o + 1] = t * t;
      P[o + 2] = t;
      P[o + 3] = 1;
    }

    const Hm = _MGR_HERMITE;
    const Ht = this._hp4t(Hm);

    const Mx = new Float32Array(16);
    const My = new Float32Array(16);
    const Mr = new Float32Array(16);
    const Mg = new Float32Array(16);
    const Mb = new Float32Array(16);

    const coeff = (getVal, getUT, getWT, out) => {
      out[0] = getVal(bl); out[1] = getVal(tl); out[2] = getWT(bl); out[3] = getWT(tl);
      out[4] = getVal(br); out[5] = getVal(tr); out[6] = getWT(br); out[7] = getWT(tr);
      out[8] = getUT(bl); out[9] = getUT(tl); out[10] = 0; out[11] = 0;
      out[12] = getUT(br); out[13] = getUT(tr); out[14] = 0; out[15] = 0;
    };
    const z = () => 0;

    for (let x = 0; x < W - 1; x++) {
      for (let y = 0; y < H - 1; y++) {
        this._readCp(x, y, bl);
        this._readCp(x + 1, y, br);
        this._readCp(x, y + 1, tl);
        this._readCp(x + 1, y + 1, tr);

        coeff((p) => p.vx, (p) => p.ux, (p) => p.wx, Mx);
        coeff((p) => p.vy, (p) => p.uy, (p) => p.wy, My);
        coeff((p) => p.r, z, z, Mr);
        coeff((p) => p.g, z, z, Mg);
        coeff((p) => p.b, z, z, Mb);

        
        const pre = (M) => {
          const t1 = this._hp4mul(this._hp4t(M), Hm);
          return this._hp4mul(Ht, t1);
        };
        const Tx = pre(Mx);
        const Ty = pre(My);
        const Tr = pre(Mr);
        const Tg = pre(Mg);
        const Tb = pre(Mb);

        const baseVx = y * sub;
        for (let u = 0; u < sub; u++) {
          const vxOff = baseVx + u;
          const uo = u * 4;
          const u3 = P[uo], u2 = P[uo + 1], u1 = P[uo + 2], u0 = P[uo + 3];

          
          const ux = [0, 0, 0, 0];
          const uy = [0, 0, 0, 0];
          const ur = [0, 0, 0, 0];
          const ug = [0, 0, 0, 0];
          const ub = [0, 0, 0, 0];
          for (let k = 0; k < 4; k++) {
            ux[k] = u3 * Tx[k] + u2 * Tx[4 + k] + u1 * Tx[8 + k] + u0 * Tx[12 + k];
            uy[k] = u3 * Ty[k] + u2 * Ty[4 + k] + u1 * Ty[8 + k] + u0 * Ty[12 + k];
            ur[k] = u3 * Tr[k] + u2 * Tr[4 + k] + u1 * Tr[8 + k] + u0 * Tr[12 + k];
            ug[k] = u3 * Tg[k] + u2 * Tg[4 + k] + u1 * Tg[8 + k] + u0 * Tg[12 + k];
            ub[k] = u3 * Tb[k] + u2 * Tb[4 + k] + u1 * Tb[8 + k] + u0 * Tb[12 + k];
          }

          for (let v = 0; v < sub; v++) {
            const vy = x * sub + v;
            const vo = v * 4;
            const v3 = P[vo], v2 = P[vo + 1], v1 = P[vo + 2], v0 = P[vo + 3];
            
            const px = v3 * ux[0] + v2 * ux[1] + v1 * ux[2] + v0 * ux[3];
            const py = v3 * uy[0] + v2 * uy[1] + v1 * uy[2] + v0 * uy[3];
            const pr = v3 * ur[0] + v2 * ur[1] + v1 * ur[2] + v0 * ur[3];
            const pg = v3 * ug[0] + v2 * ug[1] + v1 * ug[2] + v0 * ug[3];
            const pb = v3 * ub[0] + v2 * ub[1] + v1 * ub[2] + v0 * ub[3];

            const o = (vy * gW + vxOff) * 7;
            vd[o] = px;
            vd[o + 1] = py;
            vd[o + 2] = pr;
            vd[o + 3] = pg;
            vd[o + 4] = pb;
            vd[o + 5] = x / (W - 1) + v * invTH;
            vd[o + 6] = 1 - (y / (H - 1) + u * invTW);
          }
        }
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertGl);
    gl.bufferData(gl.ARRAY_BUFFER, vd, gl.DYNAMIC_DRAW);
  }

  draw() {
    const gl = this.gl;
    const stride = 7 * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertGl);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxGl);
    if (this.attrPos !== undefined) {
      gl.vertexAttribPointer(this.attrPos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.attrPos);
    }
    if (this.attrColor !== undefined) {
      gl.vertexAttribPointer(this.attrColor, 3, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(this.attrColor);
    }
    if (this.attrUV !== undefined) {
      gl.vertexAttribPointer(this.attrUV, 2, gl.FLOAT, false, stride, 20);
      gl.enableVertexAttribArray(this.attrUV);
    }
    gl.drawElements(gl.TRIANGLES, this._idxData.length, gl.UNSIGNED_SHORT, 0);
  }

  dispose() {
    const gl = this.gl;
    if (this._vertGl) gl.deleteBuffer(this._vertGl);
    if (this._idxGl) gl.deleteBuffer(this._idxGl);
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  }
  bind() {
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
  }
  dispose() {
    this.gl.deleteTexture(this.tex);
  }
}



const _MGR_PRESETS = [
  { width: 5, height: 5, points: [
    [0, 0, -1, -1], [1, 0, -0.5, -1], [2, 0, 0, -1], [3, 0, 0.5, -1], [4, 0, 1, -1],
    [0, 1, -1, -0.5], [1, 1, -0.5, -0.5],
    [2, 1, -0.0052029684413368305, -0.6131420587090777],
    [3, 1, 0.5884227308309977, -0.3990805107556692], [4, 1, 1, -0.5],
    [0, 2, -1, 0], [1, 2, -0.4210024670505933, -0.11895058380429502],
    [2, 2, -0.1019613423315412, -0.023812118047224606, 0, -47, 0.629, 0.849],
    [3, 2, 0.40275125660925437, -0.06345314544600389], [4, 2, 1, 0],
    [0, 3, -1, 0.5],
    [1, 3, 0.06801958477287173, 0.5205913248960121, -31, -45, 1, 1],
    [2, 3, 0.21446469120128908, 0.29331610114301043, 6, -56, 0.566, 1.321],
    [3, 3, 0.5, 0.5], [4, 3, 1, 0.5],
    [0, 4, -1, 1], [1, 4, -0.31378372841550195, 1], [2, 4, 0.26153633255328046, 1],
    [3, 4, 0.5, 1], [4, 4, 1, 1],
  ] },
  { width: 4, height: 4, points: [
    [0, 0, -1, -1], [1, 0, -0.33333333333333337, -1], [2, 0, 0.33333333333333326, -1], [3, 0, 1, -1],
    [0, 1, -1, -0.04495399932657351],
    [1, 1, -0.24056117520129328, -0.22465999020104],
    [2, 1, 0.334758885767489, -0.00531297192779423],
    [3, 1, 0.9989920470678106, -0.3382976020775408, 8, 0, 0.566, 1.792],
    [0, 2, -1, 0.33333333333333326],
    [1, 2, -0.3425497314639411, -0.000027501607956947893],
    [2, 2, 0.3321437945812673, 0.1981776353859399],
    [3, 2, 1, 0.0766118180296832],
    [0, 3, -1, 1], [1, 3, -0.33333333333333337, 1], [2, 3, 0.33333333333333326, 1], [3, 3, 1, 1],
  ] },
  { width: 4, height: 4, points: [
    [0, 0, -1, -1, 0, 0, 1, 2.075],
    [1, 0, -0.33333333333333337, -1], [2, 0, 0.33333333333333326, -1], [3, 0, 1, -1],
    [0, 1, -1, -0.4545779491139603],
    [1, 1, -0.33333333333333337, -0.33333333333333337],
    [2, 1, 0.0889403142626457, -0.6025711180694033, -32, 45, 1, 1],
    [3, 1, 1, -0.33333333333333337],
    [0, 2, -1, -0.07402408608567845, 1, 0, 1, 0.094],
    [1, 2, -0.2719422694359541, 0.09775369930903222, 25, -18, 1.321, 0],
    [2, 2, 0.19877414408395877, 0.4307383294587789, 48, -40, 0.755, 0.975],
    [3, 2, 1, 0.33333333333333326, -37, 0, 1, 1],
    [0, 3, -1, 1], [1, 3, -0.33333333333333337, 1],
    [2, 3, 0.5125850864305672, 1, -20, -18, 0, 1.604], [3, 3, 1, 1],
  ] },
  { width: 5, height: 5, points: [
    [0, 0, -1, -1], [1, 0, -0.4501953125, -1, 0, 55, 1, 2.075],
    [2, 0, 0.1953125, -1], [3, 0, 0.4580078125, -1, 0, -25, 1, 1], [4, 0, 1, -1],
    [0, 1, -1, -0.2514475377525607, -16, 0, 2.327, 0.943],
    [1, 1, -0.55859375, -0.6609325945787148, 47, 0, 2.358, 0.377],
    [2, 1, 0.232421875, -0.5244375756366635, -66, -25, 1.855, 1.164],
    [3, 1, 0.685546875, -0.3753706470552125], [4, 1, 1, -0.6699125300354287],
    [0, 2, -1, 0.035910396862284255],
    [1, 2, -0.4921875, 0.005378616309457018, 90, 23, 1, 1.981],
    [2, 2, 0.021484375, -0.1365043639066228, 0, 42, 1, 1],
    [3, 2, 0.4765625, 0.05925822904974043, -30, 0, 1.95, 0.44],
    [4, 2, 1, 0.251428847823418],
    [0, 3, -1, 0.6968336464764276, -68, 0, 1, 0.786],
    [1, 3, -0.6904296875, 0.5890744209958608, -68, 0, 1, 1],
    [2, 3, 0.1845703125, 0.3879238667654693, 61, 0, 1, 1],
    [3, 3, 0.60546875, 0.4633553246018661, -47, -59, 0.849, 1.73],
    [4, 3, 1, 0.6214021886400309, -33, 0, 0.377, 1.604],
    [0, 4, -1, 1], [1, 4, -0.5, 1, 0, -73, 1, 1],
    [2, 4, -0.3271484375, 1, 0, -24, 0.314, 2.704],
    [3, 4, 0.5, 1], [4, 4, 1, 1],
  ] },
  { width: 5, height: 5, points: [
    [0, 0, -1, -1], [1, 0, -0.6393, -1, 0, 0, 1, 2.3884],
    [2, 0, 0, -1], [3, 0, 0.5, -1], [4, 0, 1, -1],
    [0, 1, -1, -0.2301],
    [1, 1, -0.6934, -0.331, 0, -0.7188, 1, 1.063],
    [2, 1, -0.0082, -0.6814, -0.2583, 0, 1.0964, 1],
    [3, 1, 0.5836, -0.531, 0.7029, 0, 1.5466, 1],
    [4, 1, 1, -0.6407],
    [0, 2, -1, 0.2973, 0, 0, 1.8352, 1],
    [1, 2, -0.4082, 0.0602],
    [2, 2, -0.1803, -0.3646, -0.2998, 0, 1.1513, 1],
    [3, 2, 0.477, -0.1027, 0.8903, -0.1882, 1.0807, 0.8551],
    [4, 2, 1, -0.2973],
    [0, 3, -1, 0.7628, 0, 0, 2.3868, 1],
    [1, 3, -0.2525, 0.4814, -0.8406, -1.6199, 1.4093, 1.2215],
    [2, 3, 0.3607, 0.2814, -1.0713, -0.0529, 1.0025, 0.7611],
    [3, 3, 0.4885, 0.623, 0, 0.8184, 1, 1.2876],
    [4, 3, 1, 0.5],
    [0, 4, -1, 1], [1, 4, -0.4033, 1], [2, 4, 0.2672, 1], [3, 4, 0.5967, 1], [4, 4, 1, 1],
  ] },
  { width: 5, height: 5, points: [
    [0, 0, -1, -1], [1, 0, -0.2197, -1], [2, 0, 0.0197, -1], [3, 0, 0.8033, -1], [4, 0, 1, -1],
    [0, 1, -1, -0.5451],
    [1, 1, -0.4885, -0.4035, -1.0246, -0.2268, 1.1936, 0.8005],
    [2, 1, -0.1213, -0.2867, 0, -0.6981, 1, 0.809],
    [3, 1, 0.3246, -0.5628, 0, -1.2188, 1, 1.044],
    [4, 1, 1, -0.3292],
    [0, 2, -1, 0.1416],
    [1, 2, -0.341, -0.0142, 0, -0.4004, 1, 1.1293],
    [2, 2, -0.0393, -0.023, 0.2915, -0.373, 1.044, 0.9879],
    [3, 2, 0.3148, -0.0673, -0.7853, -0.8962, 1.4709, 1.0247],
    [4, 2, 1, 0.1912],
    [0, 3, -1, 0.5],
    [1, 3, -0.2689, 0.2743, 0.3404, -0.5248, 1.0184, 0.4391],
    [2, 3, 0.0721, 0.269, 0.5302, 0.1244, 0.6723, 0.3225],
    [3, 3, 0.4148, 0.3894, -0.6977, -0.6783, 0.8094, 0.9247],
    [4, 3, 1, 0.446],
    [0, 4, -1, 1], [1, 4, -0.7311, 1], [2, 4, 0.323, 1], [3, 4, 0.6393, 1], [4, 4, 1, 1],
  ] },
];


const _MGR_RANGE = (min, max) => Math.random() * (max - min) + min;
function _mgSmoothstep(edge0, edge1, x) {
  const t = _MGR_CLAMP01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function _mgFract(x) {
  return x - Math.floor(x);
}
function _mgNoise(x, y) {
  return _mgFract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
}
function _mgSmoothNoise(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const xf = x - x0;
  const yf = y - y0;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = _mgNoise(x0, y0);
  const n10 = _mgNoise(x1, y0);
  const n01 = _mgNoise(x0, y1);
  const n11 = _mgNoise(x1, y1);
  const nx0 = n00 * (1 - u) + n10 * u;
  const nx1 = n01 * (1 - u) + n11 * u;
  return nx0 * (1 - v) + nx1 * v;
}
function _mgNoiseGradient(x, y, epsilon = 0.001) {
  const n1 = _mgSmoothNoise(x + epsilon, y);
  const n2 = _mgSmoothNoise(x - epsilon, y);
  const n3 = _mgSmoothNoise(x, y + epsilon);
  const n4 = _mgSmoothNoise(x, y - epsilon);
  const ddx = (n1 - n2) / (2 * epsilon);
  const ddy = (n3 - n4) / (2 * epsilon);
  const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
  return [ddx / len, ddy / len];
}
function _mgSmoothify(points, w, h, iterations, factor, factorModifier) {
  let grid = [];
  for (let j = 0; j < h; j++) grid[j] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) grid[j][i] = points[j * w + i];
  }
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const ksum = 16;
  let f = factor;
  for (let it = 0; it < iterations; it++) {
    const next = [];
    for (let j = 0; j < h; j++) {
      next[j] = [];
      for (let i = 0; i < w; i++) {
        if (i === 0 || i === w - 1 || j === 0 || j === h - 1) {
          next[j][i] = grid[j][i];
          continue;
        }
        const sx = [0, 0, 0, 0, 0, 0];
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const wgt = kernel[(dj + 1) * 3 + (di + 1)];
            const nb = grid[j + dj][i + di];
            sx[0] += nb[2] * wgt; 
            sx[1] += nb[3] * wgt; 
            sx[2] += nb[4] * wgt; 
            sx[3] += nb[5] * wgt; 
            sx[4] += nb[6] * wgt; 
            sx[5] += nb[7] * wgt; 
          }
        }
        const cur = grid[j][i];
        next[j][i] = [
          i, j,
          cur[2] * (1 - f) + (sx[0] / ksum) * f,
          cur[3] * (1 - f) + (sx[1] / ksum) * f,
          cur[4] * (1 - f) + (sx[2] / ksum) * f,
          cur[5] * (1 - f) + (sx[3] / ksum) * f,
          cur[6] * (1 - f) + (sx[4] / ksum) * f,
          cur[7] * (1 - f) + (sx[5] / ksum) * f,
        ];
      }
    }
    grid = next;
    f = _MGR_CLAMP01(f + factorModifier);
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) points[j * w + i] = grid[j][i];
  }
}
function generateControlPoints(width, height) {
  const w = width || Math.floor(_MGR_RANGE(3, 6));
  const h = height || Math.floor(_MGR_RANGE(3, 6));
  const variationFraction = _MGR_RANGE(0.4, 0.6);
  const normalOffset = _MGR_RANGE(0.3, 0.6);
  const blendFactor = 0.8;
  const smoothIters = Math.floor(_MGR_RANGE(3, 5));
  const smoothFactor = _MGR_RANGE(0.2, 0.3);
  const smoothModifier = _MGR_RANGE(-0.1, -0.05);
  const dx = w === 1 ? 0 : 2 / (w - 1);
  const dy = h === 1 ? 0 : 2 / (h - 1);
  const conf = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const baseX = (w === 1 ? 0 : i / (w - 1)) * 2 - 1;
      const baseY = (h === 1 ? 0 : j / (h - 1)) * 2 - 1;
      const isBorder = i === 0 || i === w - 1 || j === 0 || j === h - 1;
      let x =
        baseX + (isBorder ? 0 : _MGR_RANGE(-variationFraction * dx, variationFraction * dx));
      let y =
        baseY + (isBorder ? 0 : _MGR_RANGE(-variationFraction * dy, variationFraction * dy));
      let ur = isBorder ? 0 : _MGR_RANGE(-60, 60);
      let vr = isBorder ? 0 : _MGR_RANGE(-60, 60);
      let up = isBorder ? 1 : _MGR_RANGE(0.8, 1.2);
      let vp = isBorder ? 1 : _MGR_RANGE(0.8, 1.2);
      if (!isBorder) {
        const uNorm = (baseX + 1) / 2;
        const vNorm = (baseY + 1) / 2;
        const nrm = _mgNoiseGradient(uNorm, vNorm, 0.001);
        let offsetX = nrm[0] * normalOffset;
        let offsetY = nrm[1] * normalOffset;
        const distToBorder = Math.min(uNorm, 1 - uNorm, vNorm, 1 - vNorm);
        const weight = _mgSmoothstep(0, 1.0, distToBorder);
        offsetX *= weight;
        offsetY *= weight;
        x = x * (1 - blendFactor) + (x + offsetX) * blendFactor;
        y = y * (1 - blendFactor) + (y + offsetY) * blendFactor;
      }
      conf.push([i, j, x, y, ur, vr, up, vp]);
    }
  }
  _mgSmoothify(conf, w, h, smoothIters, smoothFactor, smoothModifier);
  return { width: w, height: h, points: conf };
}

export default class dybg {
  constructor(canvas) {
    if (!canvas) throw new Error('dybg: canvas required');
    this._canvas = canvas;

    this._flowSpeed = 1;
    this._flowTarget = 1;
    this._renderScale = 0.5;
    this._staticMode = false;
    this._maxFPS = 60;
    this._paused = false;
    this._playing = true;
    this._playbackT = 1;
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
    this._reduced = document.createElement('canvas');
    this._reduced.width = _MGR_TEX_SIZE;
    this._reduced.height = _MGR_TEX_SIZE;

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
    for (const n of ['u_aspect', 'u_texture', 'u_volume', 'u_alpha', 'u_sinAngle', 'u_cosAngle']) {
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

  _applyPreset(mesh, preset) {
    const uPow = 2 / (preset.width - 1);
    const vPow = 2 / (preset.height - 1);
    for (const pt of preset.points) {
      mesh.setControlPoint(pt[0], pt[1], {
        x: pt[2],
        y: pt[3],
        uAng: ((pt[4] || 0) * Math.PI) / 180,
        vAng: ((pt[5] || 0) * Math.PI) / 180,
        uScale: uPow * (pt[6] !== undefined ? pt[6] : 1),
        vScale: vPow * (pt[7] !== undefined ? pt[7] : 1),
      });
    }
    mesh.updateMesh();
  }

  _genPreset(w, h) {
    return generateControlPoints(w, h);
  }

  _makeState(imageData) {
    const gl = this._gl;
    const mesh = new MGHermiteMesh(
      gl,
      this._meshProg.attrs.a_pos,
      this._meshProg.attrs.a_color,
      this._meshProg.attrs.a_uv,
    );
    mesh.resetSubdivition(50);
    const preset =
      Math.random() > 0.8
        ? this._genPreset(6, 6)
        : _MGR_PRESETS[(Math.random() * _MGR_PRESETS.length) | 0];
    mesh.resizeControlPoints(preset.width, preset.height);
    this._applyPreset(mesh, preset);
    return {
      mesh,
      texture: new _MGTexture(gl, imageData),
      alpha: 0,
      waveCp: null,
      flatCp: null,
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

  _processImage(src) {
    const c = this._reduced;
    const S = _MGR_TEX_SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, S, S);
    let w = 0;
    let h = 0;
    if (src instanceof HTMLVideoElement) {
      w = src.videoWidth;
      h = src.videoHeight;
    } else if (src instanceof ImageBitmap || src instanceof HTMLCanvasElement) {
      w = src.width;
      h = src.height;
    } else {
      w = src.naturalWidth;
      h = src.naturalHeight;
    }
    if (!w || !h) return null;
    const sc = Math.min(S / w, S / h);
    const dw = w * sc;
    const dh = h * sc;
    ctx.drawImage(src, (S - dw) / 2, (S - dh) / 2, dw, dh);
    const imageData = ctx.getImageData(0, 0, S, S);
    const px = imageData.data;
    
    for (let i = 0; i < px.length; i += 4) {
      let r = px[i];
      let g = px[i + 1];
      let b = px[i + 2];
      r = (r - 128) * 0.4 + 128;
      g = (g - 128) * 0.4 + 128;
      b = (b - 128) * 0.4 + 128;
      const gray = r * 0.3 + g * 0.59 + b * 0.11;
      r = gray * -2.0 + r * 3.0;
      g = gray * -2.0 + g * 3.0;
      b = gray * -2.0 + b * 3.0;
      r = (r - 128) * 1.7 + 128;
      g = (g - 128) * 1.7 + 128;
      b = (b - 128) * 1.7 + 128;
      px[i] = r * 0.75;
      px[i + 1] = g * 0.75;
      px[i + 2] = b * 0.75;
    }
    this._boxBlur(imageData, 2, 4, false);
    return imageData;
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
        if (isVideo) el.play().catch(() => {});
      };
      if (isVideo || /^blob:/i.test(url)) {
        loadViaElement();
      } else if (typeof createImageBitmap === 'function') {
        fetch(url, { signal: ctrl.signal })
          .then((resp) =>
            resp.ok ? resp.blob() : Promise.reject(new Error('bad status')),
          )
          .then((blob) =>
            createImageBitmap(blob, {
              resizeWidth: _MGR_TEX_SIZE,
              resizeHeight: _MGR_TEX_SIZE,
              resizeQuality: 'low',
            }),
          )
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

    const imageData = this._processImage(src);
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
    return canBeStatic;
  }

  _updatePlayback(dt) {
    if (this._manual || !this._states.length) return;
    const target = this._playing ? 1 : 0;
    if (target === 1 && this._playbackT === 1) {
      this._flowSpeed = this._flowTarget;
      for (const s of this._states) {
        s.waveCp = null;
        s.flatCp = null;
      }
      return;
    }
    if (target === 0 && this._playbackT === 0) {
      this._flowSpeed = 0;
      for (const s of this._states) {
        if (s.waveCp) continue;
        s.waveCp = s.mesh.cp.slice();
        s.flatCp = _MG_FLAT_GRID(s.mesh.cpW, s.mesh.cpH);
        s.mesh.cp.set(s.flatCp);
        s.mesh._rebuild();
      }
      return;
    }
    const dir = target > this._playbackT ? 1 : -1;
    const next = Math.min(1, Math.max(0, this._playbackT + (dir * dt) / _MG_PLAYBACK_MS));
    if (next === this._playbackT) return;
    this._playbackT = next;
    const eased = _MG_EASE(this._playbackT);
    this._flowSpeed = this._flowTarget * eased;
    const doneResume = next === 1;
    const donePause = next === 0;
    const k = doneResume ? 1 : donePause ? 0 : eased;
    for (const s of this._states) {
      if (!s.waveCp) s.waveCp = s.mesh.cp.slice();
      if (!s.flatCp) s.flatCp = _MG_FLAT_GRID(s.mesh.cpW, s.mesh.cpH);
      const cp = s.mesh.cp;
      const wf = s.waveCp;
      const ff = s.flatCp;
      for (let j = 0; j < cp.length; j++) {
        cp[j] = ff[j] + (wf[j] - ff[j]) * k;
      }
      s.mesh._rebuild();
    }
    if (doneResume) {
      for (const s of this._states) {
        s.waveCp = null;
        s.flatCp = null;
      }
    }
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

  setHasLyric() {}

  setManualControl(enable) {
    this._manual = !!enable;
  }

  setWireFrame(enable) {
    for (const s of this._states) s.mesh.setWireFrame(enable);
  }

  resizeControlPoints(width, height) {
    const s = this._states[this._states.length - 1];
    if (!s) return;
    s.mesh.resizeControlPoints(width, height);
    s.waveCp = null;
    s.flatCp = null;
    if (!this._manual) s.mesh.updateMesh();
    this._requestTick();
  }

  resetSubdivition(sub) {
    const s = this._states[this._states.length - 1];
    if (!s) return;
    s.mesh.resetSubdivition(sub);
    s.waveCp = null;
    s.flatCp = null;
    if (!this._manual) s.mesh.updateMesh();
    this._requestTick();
  }

  getControlPoint(x, y) {
    const s = this._states[this._states.length - 1];
    return s ? s.mesh.controlPoint(x, y) : undefined;
  }

  setControlPoint(cx, cy, vals) {
    const s = this._states[this._states.length - 1];
    if (!s) return;
    s.mesh.setControlPoint(cx, cy, vals);
    s.waveCp = null;
    s.flatCp = null;
    if (!this._manual) s.mesh.updateMesh();
    this._requestTick();
  }

  randomize() {
    const s = this._states[this._states.length - 1];
    if (!s) return;
    const preset =
      Math.random() > 0.8
        ? this._genPreset(6, 6)
        : _MGR_PRESETS[(Math.random() * _MGR_PRESETS.length) | 0];
    s.mesh.resizeControlPoints(preset.width, preset.height);
    this._applyPreset(s.mesh, preset);
    s.waveCp = null;
    s.flatCp = null;
    this._requestTick();
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
