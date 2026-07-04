export default class dybg {
  constructor(image, options = {}){
    if(typeof image === 'object' && !(image instanceof File || image instanceof Blob || image instanceof HTMLImageElement)){
      options = image;
      image = null;
    }
    const {
      container = document.body,
      blur = 110,
      layers = 3,
      speed = 0.35,
      twist = 1.2,
      twistRadius = 1.5,
      ca = 0.002,
    } = options;

    this._blurPx = blur;
    this._layerCount = layers;
    this._speed = speed;
    this._twistAngle = twist;
    this._twistRadius = twistRadius;
    this._caStrength = ca;
    this._img = null;
    this._layers = [];
    this._bgLayer = null;
    this._startTime = 0;
    this._animId = null;
    this._W = 0;
    this._H = 0;
    this._animT = 0;
    this._animTarget = 1;
    this._animFromVal = 0;
    this._animFromTime = 0;
    this._compScale = 0.5;
    this._lastFrameTime = 0;
    this._pinch = null;
    this._twistTargetX = 0.5;
    this._twistTargetY = 0.5;
    this._bgZoom = 1;
    this._bgTargetZoom = 1;
    this._bgPanX = 0;
    this._bgPanY = 0;
    this._bgPanTargetX = 0;
    this._bgPanTargetY = 0;

    this._container = container instanceof HTMLElement ? container : document.querySelector(container);
    if(!this._container) throw new Error('container not found');

    this._renderTarget = document.createElement('div');
    this._renderTarget.style.cssText = 'position:fixed;inset:0;overflow:hidden;background:#050506;';
    this._container.appendChild(this._renderTarget);

    this._outCanvas = document.createElement('canvas');
    this._outCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;filter:saturate(1.1) contrast(1.0) brightness(0.8);';
    this._renderTarget.appendChild(this._outCanvas);

    this._fbCanvas = document.createElement('canvas');
    this._fbCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;filter:saturate(1.1) contrast(1.0) brightness(0.8);';
    this._fbCtx = this._fbCanvas.getContext('2d');
    this._useFallback = false;

    this._compCanvas = document.createElement('canvas');
    this._compCtx = this._compCanvas.getContext('2d');

    this._dropzone = document.createElement('div');
    this._dropzone.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;cursor:pointer;z-index:5;';
    this._renderTarget.appendChild(this._dropzone);

    const glyph = document.createElement('div');
    glyph.style.cssText = 'width:56px;height:56px;border-radius:16px;border:1.5px dashed rgba(255,255,255,0.35);display:flex;align-items:center;justify-content:center;font-size:26px;color:rgba(255,255,255,0.65);';
    glyph.textContent = '+';
    this._dropzone.appendChild(glyph);

    const hint = document.createElement('p');
    hint.style.cssText = 'margin:0;color:#8a8a94;font-size:14px;letter-spacing:0.2px;font-family:-apple-system,"SF Pro Text",Helvetica,Arial,sans-serif;';
    hint.innerHTML = '<strong style="color:#e9e9ee;font-weight:600;">Click to upload</strong> an album cover / image';
    this._dropzone.appendChild(hint);

    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = 'image/*';
    this._fileInput.style.display = 'none';
    this._renderTarget.appendChild(this._fileInput);

    try {
      this._gl = this._outCanvas.getContext('webgl', { alpha: false });
    } catch(e){}
    if(this._gl && (!this._gl.isContextLost || !this._gl.isContextLost())){
      this._initGL();
    } else {
      if(this._gl) this._gl = null;
      this._useFallback = true;
      this._outCanvas.style.display = 'none';
      this._fbCanvas.style.display = 'block';
    }
    this._resize();
    if(image) this.load(image).catch(() => {});

    this._dropzone.addEventListener('click', () => this._fileInput.click());
    this._fileInput.addEventListener('change', (e) => {
      if(e.target.files && e.target.files[0]) this.load(e.target.files[0]);
    });
    window.addEventListener('dragover', this._dragOver = (e) => e.preventDefault());
    window.addEventListener('drop', this._drop = (e) => {
      e.preventDefault();
      if(e.dataTransfer.files && e.dataTransfer.files[0]) this.load(e.dataTransfer.files[0]);
    });
    window.addEventListener('resize', this._resizeHandler = () => { if(this._img) this._resize(); });
  }

  _rand(min, max){ return min + Math.random() * (max - min); }

  _randomLayerSpec(){
    const size = this._rand(0.55, 1.00) * Math.max(this._W, this._H);
    return {
      x: this._rand(-0.2, 0.6) * this._W,
      y: this._rand(-0.2, 0.6) * this._H,
      size,
      rot0: this._rand(0, 360),
      speed: this._rand(0.3, 1.5) * (Math.random() < 0.5 ? 1 : -1),
    };
  }

  _randomBgSpec(){
    const size = Math.max(this._W, this._H) * this._rand(8.0, 12.0);
    return {
      x: this._rand(-1.5, -0.3) * this._W,
      y: this._rand(-1.5, -0.3) * this._H,
      size,
      rot0: this._rand(0, 360),
      speed: this._rand(0.2, 0.6) * (Math.random() < 0.5 ? 1 : -1),
    };
  }

  _randomPinch(){
    return {
      cx1: 0.5, cy1: 0.5,
      ax1: this._rand(0.15, 0.30), ay1: this._rand(0.15, 0.30),
      wx1: this._rand(0.006, 0.020), wy1: this._rand(0.006, 0.018),
      phase1: this._rand(0, Math.PI*2),
      radius1: this._rand(0.85, 1.20),
      cx2: this._rand(0.20, 0.80), cy2: this._rand(0.20, 0.80),
      ax2: this._rand(0.08, 0.18), ay2: this._rand(0.08, 0.18),
      wx2: this._rand(0.008, 0.022), wy2: this._rand(0.008, 0.020),
      phase2: this._rand(0, Math.PI*2),
      radius2: this._rand(0.70, 1.10),
    };
  }

  _resize(){
    this._W = this._renderTarget.clientWidth || window.innerWidth;
    this._H = this._renderTarget.clientHeight || window.innerHeight;
    this._compCanvas.width = Math.round(this._W * this._compScale);
    this._compCanvas.height = Math.round(this._H * this._compScale);
    this._outCanvas.width = this._W;
    this._outCanvas.height = this._H;
    this._fbCanvas.width = this._W;
    this._fbCanvas.height = this._H;
    const gl = this._gl;
    if(gl && this._img) this._createBlurFBOs();
  }

  _buildLayers(count){
    this._layers = [];
    for(let i = 0; i < count; i++) this._layers.push(this._randomLayerSpec());
  }

  _drawContain(ctx, img, size){
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.min(size / iw, size / ih);
    ctx.drawImage(img, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
  }

  _drawCover(ctx, img, size){
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(size / iw, size / ih);
    ctx.drawImage(img, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
  }

  _renderComposite(now, dt){
    if(!this._img) return;
    const cw = this._compCanvas.width;
    const ch = this._compCanvas.height;
    const ctx = this._compCtx;
    ctx.clearRect(0, 0, cw, ch);

    ctx.save();
    ctx.translate(cw/2, ch/2);
    ctx.scale(this._bgZoom, this._bgZoom);
    ctx.translate(-cw/2 + this._bgPanX * this._compScale, -ch/2 + this._bgPanY * this._compScale);

    if(this._bgColor){
      ctx.fillStyle = this._bgColor;
      ctx.fillRect(0, 0, cw, ch);
    }
    this._drawCover(ctx, this._img, Math.max(cw, ch));

    if(this._bgLayer){
      // Accumulate angle using dt so speed changes and pause/play transitions
      // (animT ramping 0..1) integrate correctly instead of snapping.
      this._bgLayer.rot0 += this._bgLayer.speed * this._speed * this._animT * dt;
      const bgAngle = this._bgLayer.rot0 * Math.PI / 180;
      ctx.save();
      ctx.translate(
        (this._bgLayer.x + this._bgLayer.size/2) * this._compScale,
        (this._bgLayer.y + this._bgLayer.size/2) * this._compScale
      );
      ctx.rotate(bgAngle);
      this._drawCover(ctx, this._img, this._bgLayer.size * this._compScale);
      ctx.restore();
    }

    for(const L of this._layers){
      L.rot0 += L.speed * this._speed * this._animT * dt;
      const angle = L.rot0 * Math.PI / 180;
      ctx.save();
      ctx.translate(
        (L.x + L.size/2) * this._compScale,
        (L.y + L.size/2) * this._compScale
      );
      ctx.rotate(angle);
      this._drawContain(ctx, this._img, L.size * this._compScale);
      ctx.restore();
    }
    ctx.restore();
  }

  _vsSrc(){
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

  _compileShader(src, type){
    const gl = this._gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      console.error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  _initGL(){
    const gl = this._gl;

    this._kawaseProg = gl.createProgram();
    gl.attachShader(this._kawaseProg, this._compileShader(this._vsSrc(), gl.VERTEX_SHADER));
    gl.attachShader(this._kawaseProg, this._compileShader(`
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec2 u_texel;
      uniform float u_iter;
      uniform float u_scale;
      void main(){
        vec2 halfT = u_texel * 0.5;
        vec2 d = u_texel * u_iter * u_scale + halfT;
        vec4 c = texture2D(u_tex, v_uv + vec2(-d.x,  d.y));
        c    += texture2D(u_tex, v_uv + vec2( d.x,  d.y));
        c    += texture2D(u_tex, v_uv + vec2( d.x, -d.y));
        c    += texture2D(u_tex, v_uv + vec2(-d.x, -d.y));
        gl_FragColor = c * 0.25;
      }
    `, gl.FRAGMENT_SHADER));
    gl.linkProgram(this._kawaseProg);

    this._fxProg = gl.createProgram();
    gl.attachShader(this._fxProg, this._compileShader(this._vsSrc(), gl.VERTEX_SHADER));
    gl.attachShader(this._fxProg, this._compileShader(`
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec2 u_center1;
      uniform vec2 u_center2;
      uniform float u_strength1;
      uniform float u_strength2;
      uniform float u_radius1;
      uniform float u_radius2;
      uniform vec2 u_twistCenter;
      uniform float u_twistAngle;
      uniform float u_twistRadius;
      uniform float u_aspect;
      uniform float u_caStrength;
      void main(){
        vec2 uv = v_uv;
        vec2 offset = vec2(0.0);

        vec2 d1 = uv - u_center1;
        d1.x *= u_aspect;
        float dist1 = length(d1);
        float pct1 = 1.0 - smoothstep(0.0, u_radius1, dist1);
        vec2 off1 = d1 * pow(pct1, 2.2) * u_strength1;
        off1.x /= u_aspect;
        offset += off1;

        vec2 d2 = uv - u_center2;
        d2.x *= u_aspect;
        float dist2 = length(d2);
        float pct2 = 1.0 - smoothstep(0.0, u_radius2, dist2);
        vec2 off2 = d2 * pow(pct2, 2.2) * u_strength2;
        off2.x /= u_aspect;
        offset += off2;

        vec2 warpedUV = uv - offset;

        vec2 coord = warpedUV - u_twistCenter;
        coord.x *= u_aspect;
        float dist = length(coord);
        float theta = 0.0;
        if(dist < u_twistRadius && dist > 0.001){
          float pct = 1.0 - dist / u_twistRadius;
          theta = pct * pct * u_twistAngle;
          float s = sin(theta), c = cos(theta);
          coord = vec2(coord.x * c - coord.y * s, coord.x * s + coord.y * c);
        }
        coord.x /= u_aspect;
        vec2 finalUV = u_twistCenter + coord;

        vec2 caOff = (finalUV - 0.5) * u_caStrength;
        float r = texture2D(u_tex, finalUV + caOff).r;
        float g = texture2D(u_tex, finalUV).g;
        float b = texture2D(u_tex, finalUV - caOff).b;
        gl_FragColor = vec4(r, g, b, 1.0);
      }
    `, gl.FRAGMENT_SHADER));
    gl.linkProgram(this._fxProg);

    this._buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);

    this._glTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const kaPos = gl.getAttribLocation(this._kawaseProg, 'a_pos');
    gl.useProgram(this._kawaseProg);
    gl.enableVertexAttribArray(kaPos);
    gl.vertexAttribPointer(kaPos, 2, gl.FLOAT, false, 0, 0);
    this._kTexLoc   = gl.getUniformLocation(this._kawaseProg, 'u_tex');
    this._kTexelLoc = gl.getUniformLocation(this._kawaseProg, 'u_texel');
    this._kIterLoc  = gl.getUniformLocation(this._kawaseProg, 'u_iter');
    this._kScaleLoc = gl.getUniformLocation(this._kawaseProg, 'u_scale');
    gl.uniform1i(this._kTexLoc, 0);

    const pPos = gl.getAttribLocation(this._fxProg, 'a_pos');
    gl.useProgram(this._fxProg);
    gl.enableVertexAttribArray(pPos);
    gl.vertexAttribPointer(pPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(this._fxProg, 'u_tex'), 0);
    this._center1Loc    = gl.getUniformLocation(this._fxProg, 'u_center1');
    this._center2Loc    = gl.getUniformLocation(this._fxProg, 'u_center2');
    this._strength1Loc  = gl.getUniformLocation(this._fxProg, 'u_strength1');
    this._strength2Loc  = gl.getUniformLocation(this._fxProg, 'u_strength2');
    this._radius1Loc    = gl.getUniformLocation(this._fxProg, 'u_radius1');
    this._radius2Loc    = gl.getUniformLocation(this._fxProg, 'u_radius2');
    this._twistCenterLoc = gl.getUniformLocation(this._fxProg, 'u_twistCenter');
    this._twistAngleLoc  = gl.getUniformLocation(this._fxProg, 'u_twistAngle');
    this._twistRadiusLoc = gl.getUniformLocation(this._fxProg, 'u_twistRadius');
    this._aspectLoc      = gl.getUniformLocation(this._fxProg, 'u_aspect');
    this._caStrengthLoc  = gl.getUniformLocation(this._fxProg, 'u_caStrength');

    this._createBlurFBOs();
  }

  _createTex(w, h){
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

  _createBlurFBOs(){
    const gl = this._gl;
    if(!gl) return;
    this._fboW = Math.max(1, Math.round(this._W / 2));
    this._fboH = Math.max(1, Math.round(this._H / 2));
    if(this._fboATex){ gl.deleteTexture(this._fboATex); gl.deleteFramebuffer(this._fboA); }
    if(this._fboBTex){ gl.deleteTexture(this._fboBTex); gl.deleteFramebuffer(this._fboB); }
    this._fboATex = this._createTex(this._fboW, this._fboH);
    this._fboA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fboATex, 0);
    this._fboBTex = this._createTex(this._fboW, this._fboH);
    this._fboB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fboBTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _kawasePass(iter, scale, srcTex, dstFbo){
    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, this._fboW, this._fboH);
    gl.useProgram(this._kawaseProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform2f(this._kTexelLoc, 1.0 / this._fboW, 1.0 / this._fboH);
    gl.uniform1f(this._kIterLoc, iter);
    gl.uniform1f(this._kScaleLoc, scale);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _renderGL(now){
    const gl = this._gl;
    if(!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, this._glTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._compCanvas);
    } catch(_e){
      this._useFallback = true;
      this._outCanvas.style.display = 'none';
      this._fbCanvas.style.display = 'block';
      return;
    }
    if(gl.isContextLost && gl.isContextLost()){
      this._useFallback = true;
      this._outCanvas.style.display = 'none';
      this._fbCanvas.style.display = 'block';
      return;
    }

    const t = (now - this._startTime) / 1000;
    const pinch = this._pinch;
    const cx1 = pinch.cx1 + Math.sin(t * pinch.wx1 + pinch.phase1) * pinch.ax1;
    const cy1 = pinch.cy1 + Math.cos(t * pinch.wy1 + pinch.phase1) * pinch.ay1;
    const cx2 = pinch.cx2 + Math.sin(t * pinch.wx2 + pinch.phase2) * pinch.ax2;
    const cy2 = pinch.cy2 + Math.cos(t * pinch.wy2 + pinch.phase2) * pinch.ay2;

    const numPasses = Math.max(0, Math.round(this._blurPx / 6));

    if(numPasses > 0){
      this._kawasePass(0, 1.0, this._glTex, this._fboA);
      let readTex = this._fboATex, writeFbo = this._fboB;
      for(let i = 1; i < numPasses; i++){
        this._kawasePass(i, 1.0, readTex, writeFbo);
        readTex = (writeFbo === this._fboB) ? this._fboBTex : this._fboATex;
        writeFbo = (writeFbo === this._fboB) ? this._fboA : this._fboB;
      }
      const blurTex = (numPasses % 2 === 1) ? this._fboATex : this._fboBTex;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(this._fxProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, blurTex);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(this._fxProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._glTex);
    }
    gl.uniform2f(this._twistCenterLoc, this._twistCX, this._twistCY);
    gl.uniform1f(this._twistAngleLoc, this._twistAngle * this._animT);
    gl.uniform1f(this._twistRadiusLoc, this._twistRadius);
    gl.uniform2f(this._center1Loc, cx1, cy1);
    gl.uniform2f(this._center2Loc, cx2, cy2);
    gl.uniform1f(this._strength1Loc, this._animT);
    gl.uniform1f(this._strength2Loc, this._animT * 0.6);
    gl.uniform1f(this._radius1Loc, pinch.radius1);
    gl.uniform1f(this._radius2Loc, pinch.radius2);
    gl.uniform1f(this._aspectLoc, this._W / this._H);
    gl.uniform1f(this._caStrengthLoc, this._caStrength * this._animT);
    gl.viewport(0, 0, this._W, this._H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _renderFallback(){
    const fb = this._fbCtx;
    fb.clearRect(0, 0, this._W, this._H);
    fb.drawImage(this._compCanvas, 0, 0, this._W, this._H);
  }

  _loop(now){
    if(this._startTime === 0) this._startTime = now;
    if(this._animFromTime === 0) this._animFromTime = now;
    const elapsed = now - this._animFromTime;
    const raw = Math.max(0, elapsed / 1500);
    const t = Math.min(1, raw);
    const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    this._animT = this._animFromVal + (this._animTarget - this._animFromVal) * eased;
    this._bgZoom = 1.2 - 0.2 * this._animT;

    // Clamp dt so a backgrounded/throttled tab resuming doesn't produce one
    // huge rotation jump on the next frame.
    let dt = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 0;
    dt = Math.min(dt, 0.1);
    this._lastFrameTime = now;

    // Drift twist center toward random target
    if(this._animTarget === 1){
      const driftSpeed = 0.3 * dt;
      this._twistCX += (this._twistTargetX - this._twistCX) * driftSpeed;
      this._twistCY += (this._twistTargetY - this._twistCY) * driftSpeed;
      const dx = this._twistCX - this._twistTargetX;
      const dy = this._twistCY - this._twistTargetY;
      if(dx * dx + dy * dy < 0.002) this._pickTwistTarget();
    }

    // Drift pan toward random target
    if(this._animTarget === 1){
      this._bgPanX += (this._bgPanTargetX - this._bgPanX) * 0.4 * dt;
      this._bgPanY += (this._bgPanTargetY - this._bgPanY) * 0.4 * dt;
      const pdx = this._bgPanX - this._bgPanTargetX;
      const pdy = this._bgPanY - this._bgPanTargetY;
      if(pdx * pdx + pdy * pdy < 1) this._pickPanTarget();
    }

    this._renderComposite(now, dt);
    if(this._useFallback) this._renderFallback();
    else this._renderGL(now);
    this._animId = requestAnimationFrame((t) => this._loop(t));
  }

  load(image){
    if(!image) return;
    this._dropzone.style.display = 'none';
    if(image instanceof File || image instanceof Blob){
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const im = new Image();
          im.onload = () => {
            this._onImageReady(im);
            resolve();
          };
          im.src = e.target.result;
        };
        reader.readAsDataURL(image);
      });
    }
    if(typeof image === 'string'){
      return new Promise((resolve, reject) => {
        fetch(image).then(r => r.blob()).then(blob => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const im = new Image();
            im.onload = () => { this._onImageReady(im); resolve(); };
            im.src = e.target.result;
          };
          reader.readAsDataURL(blob);
        }).catch(() => {
          const im = new Image();
          im.onload = () => { this._onImageReady(im); resolve(); };
          im.onerror = reject;
          im.src = image;
        });
      });
    }
    if(image instanceof HTMLImageElement){
      this._onImageReady(image);
    }
  }

  _onImageReady(img){
    this._img = img;
    this._sampleBgColor();
    if(this._gl){
      this._useFallback = false;
      this._fbCanvas.style.display = 'none';
      this._outCanvas.style.display = 'block';
    } else {
      this._useFallback = true;
      this._outCanvas.style.display = 'none';
      this._fbCanvas.style.display = 'block';
    }
    this._resize();
    this._bgLayer = this._randomBgSpec();
    this._buildLayers(this._layerCount);
    this._pinch = this._randomPinch();
    this._randomizeTwist();
    this._dropzone.style.display = 'none';
    this._animTarget = 1;
    this._animFromVal = 0;
    this._animFromTime = 0;
    this._startTime = 0;
    this._lastFrameTime = 0;
    if(this._animId) cancelAnimationFrame(this._animId);
    this._animId = requestAnimationFrame((t) => this._loop(t));
  }

  randomize(){
    if(!this._img) return;
    this._bgLayer = this._randomBgSpec();
    this._buildLayers(this._layerCount);
    this._pinch = this._randomPinch();
    this._randomizeTwist();
    this._animTarget = 1;
    this._animFromVal = 0;
    this._animFromTime = 0;
    this._animT = 0;
    this._startTime = performance.now();
    this._lastFrameTime = 0;
  }

  _randomizeTwist(){
    this._twistCX = 0.2 + Math.random() * 0.6;
    this._twistCY = 0.2 + Math.random() * 0.6;
    this._pickTwistTarget();
  }

  _pickTwistTarget(){
    this._twistTargetX = 0.15 + Math.random() * 0.7;
    this._twistTargetY = 0.15 + Math.random() * 0.7;
  }

  _sampleBgColor(){
    if(!this._img) return;
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    const cx = c.getContext('2d');
    cx.drawImage(this._img, 0, 0, 8, 8);
    const d = cx.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0, n = 0;
    let maxSat = 0, sr = 0, sg = 0, sb = 0;
    for(let i = 0; i < d.length; i += 4){
      const dr = d[i], dg = d[i+1], db = d[i+2];
      r += dr; g += dg; b += db; n++;
      const avg = (dr + dg + db) / 3;
      const sat = Math.abs(dr - avg) + Math.abs(dg - avg) + Math.abs(db - avg);
      if(sat > maxSat){ maxSat = sat; sr = dr; sg = dg; sb = db; }
    }
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    const avg = (r + g + b) / 3;
    r = Math.min(255, Math.round(avg + (sr - avg) * 0.6));
    g = Math.min(255, Math.round(avg + (sg - avg) * 0.6));
    b = Math.min(255, Math.round(avg + (sb - avg) * 0.6));
    this._bgColor = `rgb(${r},${g},${b})`;
    this._renderTarget.style.background = this._bgColor;
  }

  _pickPanTarget(){
    this._bgPanTargetX = (Math.random() - 0.5) * 80;
    this._bgPanTargetY = (Math.random() - 0.5) * 80;
  }

  get blur(){ return this._blurPx; }
  set blur(v){
    this._blurPx = Math.max(0, Math.min(140, v));
  }

  get twist(){ return this._twistAngle; }
  set twist(v){
    this._twistAngle = Math.max(0, Math.min(8, v));
  }

  get layers(){ return this._layerCount; }
  set layers(v){
    const n = Math.max(2, Math.min(6, Math.round(v)));
    this._layerCount = n;
    if(this._img) this._buildLayers(n);
  }

  get speed(){ return this._speed; }
  set speed(v){ this._speed = v; }

  get ca(){ return this._caStrength; }
  set ca(v){ this._caStrength = Math.max(0, Math.min(0.01, v)); }

  get twistRadius(){ return this._twistRadius; }
  set twistRadius(v){ this._twistRadius = Math.max(0, Math.min(3, v)); }

  get paused(){ return this._animTarget === 0; }

  play(){
    this._animTarget = 1;
    this._animFromVal = 0;
    this._animFromTime = performance.now();
    this._animT = 0;
    this._startTime = performance.now();
    this._lastFrameTime = 0;
  }

  pause(){
    if(this._animTarget === 0) return;
    this._animTarget = 0;
    this._animFromVal = this._animT;
    this._animFromTime = performance.now();
    this._pauseTime = performance.now();
  }

  destroy(){
    if(this._animId) cancelAnimationFrame(this._animId);
    this._animId = null;
    window.removeEventListener('dragover', this._dragOver);
    window.removeEventListener('drop', this._drop);
    window.removeEventListener('resize', this._resizeHandler);
    this._renderTarget.remove();
    const gl = this._gl;
    if(gl){
      const ext = gl.getExtension('WEBGL_lose_context');
      if(ext) ext.loseContext();
    }
  }
}
