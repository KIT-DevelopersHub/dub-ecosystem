"use client";

import { useEffect, useRef } from "react";

// HeroScene — v3.1 full-bleed hero background.
//
// A raymarched SDF "organic 3D blob field": ~11 metaball spheres float, pulse and
// morph in real 3D space, lit with a bluish key + teal rim + fresnel, with a warm
// central glow. It animates from the first frame (uTime) and reacts to scroll with
// NON-LINEAR, volumetric motion — the camera dollies INTO the field (depth), the
// whole field rotates on X/Y, the FOV widens and the morph/distortion grows, all
// eased (smoothstep / pow) so it is never a flat vertical translate.
//
// Zero dependencies (raw WebGL1, GLSL ES 1.00 for max device compat). Chosen over
// three/R3F to stay light on low-power machines and keep the CI build offline-safe.
//
// Robustness: the CSS gives .hero--v31 a dark-blue gradient BEHIND this canvas, so
// there is never a white flash and a missing WebGL context degrades to that static
// gradient (title/copy stay fully readable). prefers-reduced-motion renders a
// single still frame. Mobile renders at a lower internal resolution. The RAF loop
// pauses via IntersectionObserver once the hero scrolls off-screen. It also writes
// an eased scroll progress (0..1) to the section as `--hero-scroll` so the CSS can
// move/tilt the headline in 3D in lockstep.
//
// Brand palette only (deep navy / brand blue #2f61d6 / teal #17b892 / warm gold
// accent). No goodpatch asset, shape (no heart/mascot), copy or model is used.

const VERT = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// NB blob centers are recomputed EVERY frame on the CPU (updateBlobs) and pushed
// in as a uniform array. They depend only on uTime (not on the pixel/ray), so
// hoisting them out of the per-pixel raymarch loop removes ~6 transcendentals ×
// NB × (steps + normal taps) per pixel with mathematically identical output —
// the single biggest, invisible GPU win here. Only the per-blob radius (which
// carries a precision-sensitive hash) stays in-shader so the exact silhouette is
// preserved bit-for-bit on the viewer's own GPU.
const FRAG = `
precision highp float;
uniform float uTime;
uniform float uScroll;
uniform vec2  uRes;
uniform vec3  uBlob[11]; // CPU-computed blob centers (hoisted, per-frame)

const int STEPS = 48;
const int NB = 11;

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
float hash(float n){ return fract(sin(n)*43758.5453123); }

float map(vec3 p, float t, float morph){
  // organic domain warp → shapes are non-spherical and slowly morph (脈動)
  p += 0.18*morph*vec3(sin(p.y*1.3+t), sin(p.z*1.1+t*1.1), sin(p.x*1.2+t*0.9));
  float d = 1e5;
  for(int i=0;i<NB;i++){
    float fi = float(i);
    float r = 0.55 + 0.35*hash(fi+1.0) + 0.12*sin(t*0.9 + fi*2.0);
    d = smin(d, length(p - uBlob[i]) - r, 0.85);
  }
  return d;
}
// 4-tap tetrahedron gradient (was 6-tap central difference): visually identical
// normals for two fewer map() evaluations per lit pixel.
vec3 calcNormal(vec3 p, float t, float m){
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0016;
  return normalize(
    k.xyy*map(p + k.xyy*e, t, m) +
    k.yyx*map(p + k.yyx*e, t, m) +
    k.yxy*map(p + k.yxy*e, t, m) +
    k.xxx*map(p + k.xxx*e, t, m));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes.xy)/uRes.y;
  float t = uTime;
  float scroll = uScroll;

  // NON-LINEAR scroll drivers
  float ease  = scroll*scroll*(3.0-2.0*scroll);   // smoothstep-ish
  float morph = 0.25 + ease*0.85;
  float rot   = t*0.05 + ease*2.2;                 // field rotation grows w/ scroll
  float dolly = ease*6.0;                           // camera pushes INTO the field
  float fov   = 1.0 + ease*0.35;

  vec3 ro = vec3(0.0, 0.0, 7.5 - dolly);
  vec3 rd = normalize(vec3(uv*fov, -1.3));
  mat3 rm = rotY(rot) * rotX(sin(t*0.07)*0.15 + ease*0.5);
  ro = rm*ro; rd = rm*rd;

  float dO = 0.0; bool hit=false; vec3 p = ro;
  for(int i=0;i<STEPS;i++){
    p = ro + rd*dO;
    float ds = map(p, t, morph);
    if(ds < 0.002){ hit=true; break; }
    dO += ds*0.9; // slightly larger stride keeps the same reach with fewer steps
    if(dO > 22.0) break;
  }

  vec3 bg = mix(vec3(0.02,0.05,0.16), vec3(0.05,0.11,0.32), uv.y*0.5+0.5);
  vec3 col = bg;

  if(hit){
    vec3 n = calcNormal(p, t, morph);
    vec3 L1 = normalize(vec3(0.6, 0.8, 0.4));
    vec3 L2 = normalize(vec3(-0.5, -0.3, 0.7));
    float dif  = max(dot(n, L1), 0.0);
    float dif2 = max(dot(n, L2), 0.0);
    float rim  = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);

    vec3 blue = vec3(0.18, 0.38, 0.84);
    vec3 teal = vec3(0.09, 0.72, 0.57);
    vec3 base = mix(blue, teal, 0.5+0.5*sin(p.x*0.4 + p.y*0.3 + t*0.2));
    col  = base*(0.25 + 0.9*dif) + teal*dif2*0.35;
    col += rim*vec3(0.5, 0.75, 1.0)*0.9;

    float fog = 1.0 - exp(-0.055*dO*dO);          // depth fade (DOF/fog)
    col = mix(col, bg, fog*0.75);
  }

  // abstract warm focal glow (pulses) — evokes the reference's central light,
  // NOT a heart/mascot. Brightens a touch as you scroll in.
  float cd = length(uv);
  float glow = exp(-cd*cd*3.2) * (0.5 + 0.5*sin(t*0.8));
  col += vec3(0.95, 0.55, 0.28) * glow * 0.45 * (0.6 + 0.4*ease);

  col *= 1.0 - 0.24*dot(uv, uv);                   // vignette
  col = pow(max(col, 0.0), vec3(0.85));            // gamma
  gl_FragColor = vec4(col, 1.0);
}
`;

function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn("[HeroScene] shader compile failed:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function HeroScene() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const section = canvas.closest(".hero") as HTMLElement | null;
    const reduced = prefersReduced();
    const isMobile = window.matchMedia?.("(max-width: 820px)").matches ?? false;

    const gl =
      (canvas.getContext("webgl", {
        antialias: false,
        alpha: false,
        depth: false,
        powerPreference: "high-performance",
      }) as WebGLRenderingContext | null) ||
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);

    // No WebGL → CSS gradient behind stays; still drive the headline via scroll.
    let scrollCleanup = () => {};
    if (!gl) {
      scrollCleanup = wireScrollVarOnly(section);
      return scrollCleanup;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) {
      scrollCleanup = wireScrollVarOnly(section);
      return scrollCleanup;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      scrollCleanup = wireScrollVarOnly(section);
      return scrollCleanup;
    }
    gl.useProgram(prog);

    // full-screen triangle
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, "uTime");
    const uScroll = gl.getUniformLocation(prog, "uScroll");
    const uRes = gl.getUniformLocation(prog, "uRes");
    const uBlob = gl.getUniformLocation(prog, "uBlob[0]");

    // Per-frame blob centers, hoisted out of the fragment shader (see FRAG note).
    // Same formula as the old in-shader centers; f64→f32 rounding differs only at
    // ~1e-6 world units (no fract amplification) so the field is visually identical.
    const NB = 11;
    const blobData = new Float32Array(NB * 3);
    const updateBlobs = (t: number) => {
      for (let i = 0; i < NB; i++) {
        blobData[i * 3 + 0] = Math.sin(t * 0.35 + i * 1.7) * 2.4 + Math.cos(i * 2.1) * 1.2;
        blobData[i * 3 + 1] = Math.cos(t * 0.3 + i * 2.3) * 1.8 + Math.sin(i * 1.3) * 1.0;
        blobData[i * 3 + 2] = Math.sin(t * 0.25 + i * 0.9) * 2.2 - 1.0 + Math.cos(i * 0.7) * 1.4;
      }
      gl.uniform3fv(uBlob, blobData);
    };

    // internal resolution scale — softly downscaled (the blob field is fog-soft,
    // so a ~1.0 effective DPR is indistinguishable from the old 1.35 while cutting
    // ~45% of fragment work). Mobile & DPR clamps go lower still.
    const renderScale = reduced ? 1.0 : isMobile ? 0.6 : 0.8;
    const dprCap = isMobile ? 1.0 : 1.25;

    // Frame-rate cap: the field drifts slowly, so 40fps (30 on mobile) is visually
    // identical to 60 but ~33% less GPU/CPU. Motion stays time-based (dt) so the
    // perceived speed is unchanged.
    const targetFps = reduced ? 0 : isMobile ? 30 : 40;
    const frameInterval = targetFps > 0 ? 1000 / targetFps : 0;

    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap) * renderScale;
      const cw = canvas.clientWidth || window.innerWidth;
      const ch = canvas.clientHeight || window.innerHeight;
      w = Math.max(1, Math.round(cw * dpr));
      h = Math.max(1, Math.round(ch * dpr));
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // eased scroll progress (0..1) over the first viewport of the hero
    let scrollTarget = 0;
    let scrollEased = 0;
    const readScroll = () => {
      const vh = window.innerHeight || 1;
      const p = Math.min(Math.max(window.scrollY / (vh * 0.95), 0), 1.15);
      scrollTarget = p;
    };
    readScroll();
    window.addEventListener("scroll", readScroll, { passive: true });

    let onScreen = true;
    const shouldRun = () => onScreen && !document.hidden && !reduced;
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
        if (shouldRun() && raf === 0) {
          lastRender = 0;
          last = performance.now();
          raf = requestAnimationFrame(loop);
        }
      },
      { threshold: 0 },
    );
    if (section) io.observe(section);

    let raf = 0;
    let last = performance.now();
    let lastRender = 0;
    let time = 0;

    // dt-based smoothing so the scroll follow feels identical at any frame rate
    const easeToward = (dt: number) => {
      const f = 1 - Math.pow(1 - 0.08, Math.min(dt * 60, 4));
      scrollEased += (scrollTarget - scrollEased) * f;
    };

    const render = () => {
      if (section) section.style.setProperty("--hero-scroll", scrollEased.toFixed(4));
      updateBlobs(time);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uScroll, Math.min(scrollEased, 1));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      raf = shouldRun() ? requestAnimationFrame(loop) : 0;
      // frame-rate cap (time-based motion, so perceived speed is unchanged)
      if (frameInterval > 0 && now - lastRender < frameInterval - 1) return;
      const dt = Math.min((now - lastRender) / 1000, 0.1);
      lastRender = now;
      time += dt;
      easeToward(dt);
      render();
    };

    // context loss / restore
    const onLost = (e: Event) => {
      e.preventDefault();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    canvas.addEventListener("webglcontextlost", onLost, false);

    // pause entirely when the tab is backgrounded
    const onVis = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (shouldRun() && raf === 0) {
        lastRender = 0;
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    if (reduced) {
      // single still frame; still keep the headline scroll-linked (cheap)
      render();
      const onScrollStatic = () => {
        readScroll();
        scrollEased = scrollTarget;
        render();
      };
      window.addEventListener("scroll", onScrollStatic, { passive: true });
      scrollCleanup = () => window.removeEventListener("scroll", onScrollStatic);
    } else {
      render(); // draw frame 0 immediately so there is no black gap before the cap
      last = performance.now();
      lastRender = last;
      raf = requestAnimationFrame(loop);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", readScroll);
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      ro.disconnect();
      io.disconnect();
      scrollCleanup();
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return <canvas ref={canvasRef} className="hero-canvas" aria-hidden="true" />;
}

// Fallback: no WebGL — still feed --hero-scroll so the headline motion works.
function wireScrollVarOnly(section: HTMLElement | null): () => void {
  if (!section) return () => {};
  let eased = 0;
  let raf = 0;
  const tick = () => {
    const vh = window.innerHeight || 1;
    const target = Math.min(Math.max(window.scrollY / (vh * 0.95), 0), 1.15);
    eased += (target - eased) * 0.1;
    section.style.setProperty("--hero-scroll", eased.toFixed(4));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
