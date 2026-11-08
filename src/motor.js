// =====================================================================
// motor.js — Vetorizador (sem IA): pré-tratamento + separação de cores
// + traçado com Potrace (curvas suaves) ou VTracer (WASM, opcional).
// Funciona igual no navegador (Web Worker) e no Node (CLI).
// =====================================================================
import Bitmap from './potrace/Bitmap.js';
import bitmapToPathList from './potrace/bitmapToPathList.js';
import processPath from './potrace/processPath.js';

/* ============================ Cores ============================ */
function linear(v) {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function rgbParaOklab(r, g, b) {
  const lr = linear(r), lg = linear(g), lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
export function paraHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function deHex(h) {
  const s = String(h || '').replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.padEnd(6, '0').slice(0, 6);
  return [parseInt(full.slice(0, 2), 16) || 0, parseInt(full.slice(2, 4), 16) || 0, parseInt(full.slice(4, 6), 16) || 0];
}
function dist2Lab(a, b) {
  const d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

// c é mistura (antisserrilhado) das cores ca e cb?
function misturaDe(c, ca, cb) {
  const sx = cb[0] - ca[0], sy = cb[1] - ca[1], sz = cb[2] - ca[2];
  const L2 = sx * sx + sy * sy + sz * sz;
  if (L2 < 100) return false;
  const t = ((c[0] - ca[0]) * sx + (c[1] - ca[1]) * sy + (c[2] - ca[2]) * sz) / L2;
  if (t <= 0.1 || t >= 0.9) return false;
  const ex = c[0] - (ca[0] + t * sx), ey = c[1] - (ca[1] + t * sy), ez = c[2] - (ca[2] + t * sz);
  return Math.sqrt(ex * ex + ey * ey + ez * ez) < Math.min(0.18 * Math.sqrt(L2), 45);
}

/* ============================ Imagem ============================ */
// img = { rgba: Uint8ClampedArray, w, h }

export function infoImagem(img) {
  const { rgba, w, h } = img;
  let transp = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) transp++;
  return { transparencia: transp / (w * h) > 0.002 };
}

// Filtro bilateral: tira ruído de JPG mantendo as bordas.
export function suavizarRuido(img, raio = 2, sigmaS = 1.2, sigmaR = 16) {
  const { rgba, w, h } = img;
  if (w * h > 5e6) raio = 1;
  const out = new Uint8ClampedArray(rgba.length);
  const pesosS = [], offs = [];
  for (let dy = -raio; dy <= raio; dy++)
    for (let dx = -raio; dx <= raio; dx++) {
      pesosS.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)));
      offs.push([dx, dy]);
    }
  const lutR = new Float32Array(3 * 256 * 256 / 16 + 1);
  for (let i = 0; i < lutR.length; i++) lutR[i] = Math.exp(-(i * 16) / (2 * sigmaR * sigmaR));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a0 = rgba[o + 3];
      if (a0 < 128) { out[o] = rgba[o]; out[o + 1] = rgba[o + 1]; out[o + 2] = rgba[o + 2]; out[o + 3] = a0; continue; }
      const r0 = rgba[o], g0 = rgba[o + 1], b0 = rgba[o + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let k = 0; k < offs.length; k++) {
        const xx = x + offs[k][0], yy = y + offs[k][1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const p = (yy * w + xx) * 4;
        if (rgba[p + 3] < 128) continue;
        const dr = rgba[p] - r0, dg = rgba[p + 1] - g0, db = rgba[p + 2] - b0;
        const wt = pesosS[k] * lutR[(dr * dr + dg * dg + db * db) >> 4];
        sr += rgba[p] * wt; sg += rgba[p + 1] * wt; sb += rgba[p + 2] * wt; sw += wt;
      }
      out[o] = sr / sw; out[o + 1] = sg / sw; out[o + 2] = sb / sw; out[o + 3] = a0;
    }
  }
  return { rgba: out, w, h };
}

// Pesos bicúbicos (Catmull-Rom) ou média de área (redução).
function pesosEixo(n, N) {
  const escala = N / n;
  const idx = [], wts = [];
  if (escala >= 1) {
    for (let X = 0; X < N; X++) {
      const sx = (X + 0.5) / escala - 0.5;
      const x0 = Math.floor(sx);
      const t = sx - x0;
      const ii = [], ww = [];
      for (let k = -1; k <= 2; k++) {
        const d = Math.abs(k - t);
        let wgt;
        if (d < 1) wgt = 1.5 * d * d * d - 2.5 * d * d + 1;
        else if (d < 2) wgt = -0.5 * d * d * d + 2.5 * d * d - 4 * d + 2;
        else wgt = 0;
        ii.push(Math.min(n - 1, Math.max(0, x0 + k)));
        ww.push(wgt);
      }
      idx.push(ii); wts.push(ww);
    }
  } else {
    const passo = n / N;
    for (let X = 0; X < N; X++) {
      const a = X * passo, b = (X + 1) * passo;
      const ii = [], ww = [];
      for (let x = Math.floor(a); x < Math.ceil(b); x++) {
        const cob = Math.min(b, x + 1) - Math.max(a, x);
        if (cob > 0) { ii.push(Math.min(n - 1, x)); ww.push(cob); }
      }
      const s = ww.reduce((p, c) => p + c, 0);
      idx.push(ii); wts.push(ww.map((v) => v / s));
    }
  }
  return { idx, wts };
}

// Redimensiona com alfa pré-multiplicado (sem halo escuro em PNG transparente).
export function redimensionar(img, W, H) {
  const { rgba, w, h } = img;
  if (W === w && H === h) return { rgba: new Uint8ClampedArray(rgba), w, h };
  const px = pesosEixo(w, W), py = pesosEixo(h, H);
  const tmp = new Float32Array(W * h * 4);
  for (let y = 0; y < h; y++) {
    const lin = y * w;
    for (let X = 0; X < W; X++) {
      const ii = px.idx[X], ww = px.wts[X];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < ii.length; k++) {
        const o = (lin + ii[k]) * 4, wt = ww[k];
        const al = rgba[o + 3] / 255;
        r += rgba[o] * al * wt; g += rgba[o + 1] * al * wt; b += rgba[o + 2] * al * wt; a += al * wt;
      }
      const t = (y * W + X) * 4;
      tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b; tmp[t + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const ii = py.idx[Y], ww = py.wts[Y];
    for (let X = 0; X < W; X++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < ii.length; k++) {
        const t = (ii[k] * W + X) * 4, wt = ww[k];
        r += tmp[t] * wt; g += tmp[t + 1] * wt; b += tmp[t + 2] * wt; a += tmp[t + 3] * wt;
      }
      const o = (Y * W + X) * 4;
      if (a > 0.004) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = Math.max(0, Math.min(1, a)) * 255;
    }
  }
  return { rgba: out, w: W, h: H };
}

export const ALVOS = { rapida: 1200, normal: 2000, alta: 3000 };
export function dimensoesDeTrabalho(w, h, qualidade = 'normal') {
  const alvo = ALVOS[qualidade] || ALVOS.normal;
  const lado = Math.max(w, h);
  let f = alvo / lado;
  if (f > 8) f = 8;
  if (f < 0.25) f = 0.25;
  if (f < 1 && f > 0.92) f = 1; // quase do tamanho: não reamostra à toa
  return { W: Math.max(1, Math.round(w * f)), H: Math.max(1, Math.round(h * f)), f };
}

/* ============================ Paleta ============================ */
function rngSemente(s) {
  return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function kmeans(pts, K, iteracoes = 20) {
  // pts: [{lab, rgb, w}] ; inicialização determinística "k-means++ guloso"
  if (!pts.length) return [];
  K = Math.min(K, pts.length);
  let iMax = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].w > pts[iMax].w) iMax = i;
  const centros = [{ lab: pts[iMax].lab.slice(), rgb: pts[iMax].rgb.slice(), w: 0 }];
  const dmin = new Float64Array(pts.length).fill(Infinity);
  while (centros.length < K) {
    const c = centros[centros.length - 1];
    let best = -1, bestScore = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = dist2Lab(pts[i].lab, c.lab);
      if (d < dmin[i]) dmin[i] = d;
      const sc = dmin[i] * Math.sqrt(pts[i].w);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (bestScore <= 1e-9) break;
    centros.push({ lab: pts[best].lab.slice(), rgb: pts[best].rgb.slice(), w: 0 });
  }
  const atrib = new Int32Array(pts.length);
  for (let it = 0; it < iteracoes; it++) {
    let mudou = false;
    for (let i = 0; i < pts.length; i++) {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < centros.length; k++) {
        const d = dist2Lab(pts[i].lab, centros[k].lab);
        if (d < bd) { bd = d; bi = k; }
      }
      if (atrib[i] !== bi || it === 0) { mudou = true; atrib[i] = bi; }
    }
    const acc = centros.map(() => ({ l: [0, 0, 0], r: [0, 0, 0], w: 0 }));
    for (let i = 0; i < pts.length; i++) {
      const a = acc[atrib[i]], p = pts[i], wt = p.w;
      a.w += wt;
      for (let c = 0; c < 3; c++) { a.l[c] += p.lab[c] * wt; a.r[c] += p.rgb[c] * wt; }
    }
    for (let k = 0; k < centros.length; k++) {
      if (acc[k].w > 0) {
        centros[k].lab = acc[k].l.map((v) => v / acc[k].w);
        centros[k].rgb = acc[k].r.map((v) => v / acc[k].w);
      }
      centros[k].w = acc[k].w;
    }
    if (!mudou) break;
  }
  return centros.filter((c) => c.w > 0);
}

function fundir(centros, tol) {
  const t2 = tol * tol;
  for (;;) {
    let bi = -1, bj = -1, bd = Infinity;
    for (let i = 0; i < centros.length; i++)
      for (let j = i + 1; j < centros.length; j++) {
        const d = dist2Lab(centros[i].lab, centros[j].lab);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    if (bi < 0 || bd >= t2) break;
    const a = centros[bi], b = centros[bj], wt = a.w + b.w;
    centros[bi] = {
      lab: a.lab.map((v, c) => (v * a.w + b.lab[c] * b.w) / wt),
      rgb: a.rgb.map((v, c) => (v * a.w + b.rgb[c] * b.w) / wt),
      w: wt,
    };
    centros.splice(bj, 1);
  }
  return centros;
}

// Estima as cores "chapadas" da arte. nCores = 0 → automático.
export function estimarPaleta(img, nCores = 0, opts = {}) {
  const ladoMax = opts.ladoPaleta ?? 700;
  if (Math.max(img.w, img.h) > ladoMax) {
    const k = ladoMax / Math.max(img.w, img.h);
    img = redimensionar(img, Math.max(1, Math.round(img.w * k)), Math.max(1, Math.round(img.h * k)));
  }
  const { rgba, w, h } = img;
  const LIM = opts.limitePlano ?? 42;
  const cnt = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  let opacos = 0, planos = 0;
  const add = (o) => {
    const k = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    cnt[k]++; sr[k] += rgba[o]; sg[k] += rgba[o + 1]; sb[k] += rgba[o + 2];
  };
  const vizinhos = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (rgba[o + 3] < 128) continue;
      opacos++;
      let plano = true;
      for (const [dx, dy] of vizinhos) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const p = (yy * w + xx) * 4;
        if (rgba[p + 3] < 128) { plano = false; break; }
        if (Math.abs(rgba[p] - rgba[o]) + Math.abs(rgba[p + 1] - rgba[o + 1]) + Math.abs(rgba[p + 2] - rgba[o + 2]) > LIM) { plano = false; break; }
      }
      if (plano) { planos++; add(o); }
    }
  if (opacos === 0) return [];
  if (planos < opacos * 0.12) {
    cnt.fill(0); sr.fill(0); sg.fill(0); sb.fill(0);
    for (let o = 0; o < rgba.length; o += 4) if (rgba[o + 3] >= 128) add(o);
  }
  const pts = [];
  let total = 0;
  for (let k = 0; k < 32768; k++) {
    if (!cnt[k]) continue;
    const rgb = [sr[k] / cnt[k], sg[k] / cnt[k], sb[k] / cnt[k]];
    pts.push({ rgb, lab: rgbParaOklab(rgb[0], rgb[1], rgb[2]), w: cnt[k] });
    total += cnt[k];
  }
  let centros;
  if (nCores > 0) {
    centros = kmeans(pts, nCores, 30);
  } else {
    const maxAuto = opts.maxAuto ?? 12;
    centros = kmeans(pts, maxAuto, 25);
    centros = fundir(centros, opts.tolFusao ?? 0.06);
    const minW = Math.max(20, total * (opts.fracaoMin ?? 0.0003));
    let pequenos = centros.filter((c) => c.w < minW);
    if (pequenos.length && pequenos.length < centros.length) centros = centros.filter((c) => c.w >= minW);
    // refina com as cores que sobraram
    centros = refinar(pts, centros, 6);
    centros = fundir(centros, opts.tolFusao ?? 0.06);
  }
  centros.sort((a, b) => b.w - a.w);
  return centros.map((c) => ({ rgb: c.rgb.map((v) => Math.round(v)), peso: c.w / total }));
}

function refinar(pts, centros, it) {
  let cs = centros.map((c) => ({ lab: c.lab.slice(), rgb: c.rgb.slice(), w: c.w }));
  for (let n = 0; n < it; n++) {
    const acc = cs.map(() => ({ l: [0, 0, 0], r: [0, 0, 0], w: 0 }));
    for (const p of pts) {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < cs.length; k++) { const d = dist2Lab(p.lab, cs[k].lab); if (d < bd) { bd = d; bi = k; } }
      const a = acc[bi]; a.w += p.w;
      for (let c = 0; c < 3; c++) { a.l[c] += p.lab[c] * p.w; a.r[c] += p.rgb[c] * p.w; }
    }
    cs = cs.map((c, k) => (acc[k].w > 0 ? { lab: acc[k].l.map((v) => v / acc[k].w), rgb: acc[k].r.map((v) => v / acc[k].w), w: acc[k].w } : null)).filter(Boolean);
  }
  return cs;
}

/* ======================= Classificação ======================= */
// Cada pixel vira o índice de uma cor da paleta (ou -1 = transparente).
// 1) Pixel perto de uma cor da paleta ("chapado") fica com ela.
// 2) Pixel de borda (mistura de 2 cores por antisserrilhado/JPG) é "desmisturado": vai para a mais
//    próxima das duas cores que formam a mistura. Com raio > 0, só valem as cores que aparecem
//    chapadas ali perto — assim a borda preto/branco não vira cinza só porque cinza existe na paleta.
export function classificar(img, centros, raio = 0) {
  const { rgba, w, h } = img;
  const N = w * h;
  const K = centros.length;
  const lab = new Int8Array(N);
  if (K === 0) { lab.fill(-1); return lab; }
  let minPar = Infinity;
  for (let i = 0; i < K; i++)
    for (let j = i + 1; j < K; j++) {
      const d = Math.hypot(centros[i][0] - centros[j][0], centros[i][1] - centros[j][1], centros[i][2] - centros[j][2]);
      if (d < minPar) minPar = d;
    }
  const tolPlano = Math.min(24, 0.3 * (isFinite(minPar) ? minPar : 999));
  // decisão: devolve índice; mascara (bits) restringe as cores candidatas
  const decidir = (r, g, b, mascara, estrito) => {
    let i1 = -1, d1 = Infinity;
    for (let k = 0; k < K; k++) {
      if (!(mascara & (1 << k))) continue;
      const c = centros[k];
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < d1) { d1 = d; i1 = k; }
    }
    if (i1 < 0) return -2;
    d1 = Math.sqrt(d1);
    if (d1 <= tolPlano) return i1;
    let bRes = Infinity, bA = -1, bB = -1, bT = 0;
    let cRes = Infinity, cA = -1, cB = -1, cT = 0;
    for (let a = 0; a < K; a++) {
      if (!(mascara & (1 << a))) continue;
      const A = centros[a];
      for (let b2 = a + 1; b2 < K; b2++) {
        if (!(mascara & (1 << b2))) continue;
        const B = centros[b2];
        const sx = B[0] - A[0], sy = B[1] - A[1], sz = B[2] - A[2];
        const L2 = sx * sx + sy * sy + sz * sz;
        if (L2 < 1) continue;
        const t = ((r - A[0]) * sx + (g - A[1]) * sy + (b - A[2]) * sz) / L2;
        if (t <= 0 || t >= 1) continue;
        const ex = r - (A[0] + t * sx), ey = g - (A[1] + t * sy), ez = b - (A[2] + t * sz);
        const res = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (res < bRes) { bRes = res; bA = a; bB = b2; bT = t; }
        if ((a === i1 || b2 === i1) && res < cRes) { cRes = res; cA = a; cB = b2; cT = t; }
      }
    }
    if (estrito) {
      // só aceita se as cores de perto explicam bem o pixel; senão, volta para a paleta toda
      const lim = Math.max(2 * tolPlano, 30);
      if (bA >= 0 && bRes <= lim) {
        if (cA >= 0 && cRes <= bRes * 1.4 + 6) return cT < 0.5 ? cA : cB;
        return bT < 0.5 ? bA : bB;
      }
      return d1 <= lim ? i1 : -2;
    }
    // prefere explicações que envolvem a cor mais próxima (evita trocar texto verde desbotado por marrom)
    if (cA >= 0 && cRes <= bRes * 1.4 + 6) return cT < 0.5 ? cA : cB;
    if (bA >= 0 && bRes < d1 * 0.55) return bT < 0.5 ? bA : bB;
    return i1;
  };
  const todas = (1 << K) - 1;
  const lut = new Int8Array(1 << 18).fill(-2);      // decisão com a paleta toda
  const lutPerto = new Int16Array(1 << 18).fill(-1); // cor chapada (ou 255 = não chapado)
  const chave = (o) => ((rgba[o] >> 2) << 12) | ((rgba[o + 1] >> 2) << 6) | (rgba[o + 2] >> 2);
  const centro = (v) => (v & 0xfc) + 2;
  const plano = (key, o) => {
    let v = lutPerto[key];
    if (v === -1) {
      const r = centro(rgba[o]), g = centro(rgba[o + 1]), b = centro(rgba[o + 2]);
      let i1 = 0, d1 = Infinity;
      for (let k = 0; k < K; k++) { const c = centros[k]; const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2; if (d < d1) { d1 = d; i1 = k; } }
      v = Math.sqrt(d1) <= tolPlano ? i1 : 255;
      lutPerto[key] = v;
    }
    return v;
  };
  const geral = (key, o) => {
    let v = lut[key];
    if (v === -2) { v = decidir(centro(rgba[o]), centro(rgba[o + 1]), centro(rgba[o + 2]), todas, false); lut[key] = v; }
    return v;
  };
  if (!(raio > 0) || K > 15) {
    for (let i = 0, o = 0; i < N; i++, o += 4) lab[i] = rgba[o + 3] < 128 ? -1 : geral(chave(o), o);
    return lab;
  }
  // máscara das cores chapadas por perto (dilatação separável de bits)
  const m0 = new Uint16Array(N);
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    if (rgba[o + 3] < 128) continue;
    const v = plano(chave(o), o);
    if (v !== 255) m0[i] = 1 << v;
  }
  const R = Math.max(2, Math.round(raio));
  const m1 = new Uint16Array(N);
  for (let y = 0; y < h; y++) {
    const lin = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const x0 = x - R < 0 ? 0 : x - R, x1 = x + R >= w ? w - 1 : x + R;
      for (let xx = x0; xx <= x1; xx++) m |= m0[lin + xx];
      m1[lin + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      const y0 = y - R < 0 ? 0 : y - R, y1 = y + R >= h ? h - 1 : y + R;
      for (let yy = y0; yy <= y1; yy++) m |= m1[yy * w + x];
      m0[y * w + x] = m;
    }
  }
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    if (rgba[o + 3] < 128) { lab[i] = -1; continue; }
    const key = chave(o);
    const v = plano(key, o);
    if (v !== 255) { lab[i] = v; continue; }
    const m = m0[i];
    if (m && (m & (m - 1))) { // pelo menos 2 cores chapadas por perto
      const d = decidir(rgba[o], rgba[o + 1], rgba[o + 2], m, true);
      lab[i] = d >= 0 ? d : geral(key, o);
    } else lab[i] = geral(key, o);
  }
  return lab;
}

// Preto e branco: limiar automático (Otsu), adaptativo (foto de papel / luz irregular) ou manual.
function otsu(lum) {
  const N = lum.length;
  const hist = new Float64Array(256);
  for (let i = 0; i < N; i++) hist[lum[i]]++;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, tBest = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; tBest = t; }
  }
  return tBest + 0.5;
}
export function classificarPB(img, modoLimiar = 'auto', valor = 128, inverter = false, sens = 15) {
  const { rgba, w, h } = img;
  const N = w * h;
  const lum = new Uint8Array(N);
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    const a = rgba[o + 3] / 255;
    const r = 255 + (rgba[o] - 255) * a, g = 255 + (rgba[o + 1] - 255) * a, b = 255 + (rgba[o + 2] - 255) * a;
    lum[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const lab = new Int8Array(N).fill(-1);
  const tOtsu = otsu(lum);
  const ehTransp = (i) => rgba[i * 4 + 3] < 128;
  let limiarUsado = modoLimiar === 'manual' ? valor : tOtsu;
  if (modoLimiar === 'adaptativo') {
    // Bradley–Roth com imagem integral + piso global (evita "furar" áreas pretas grandes)
    const W1 = w + 1;
    const integ = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) { s += lum[y * w + x]; integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + s; }
    }
    const jan = Math.max(16, Math.round(Math.min(w, h) / 8));
    const r = jan >> 1;
    const piso = tOtsu * 0.5;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const soma = integ[(y1 + 1) * W1 + x1 + 1] - integ[y0 * W1 + x1 + 1] - integ[(y1 + 1) * W1 + x0] + integ[y0 * W1 + x0];
        const v = lum[y * w + x];
        const tinta = v * area < soma * (1 - sens / 100) || v < piso;
        if (tinta !== inverter) lab[y * w + x] = 0;
      }
    }
    limiarUsado = -1;
  } else {
    for (let i = 0; i < N; i++) {
      const tinta = lum[i] < limiarUsado;
      if (tinta !== inverter) lab[i] = 0;
    }
  }
  // pixel transparente nunca vira traço (nem com "inverter")
  for (let i = 0; i < N; i++) if (ehTransp(i)) lab[i] = -1;
  return { lab, limiar: limiarUsado };
}

/* ========================== Limpeza ========================== */
// Maioria 3x3 (+ remove linhas de 1 px, que no tamanho ampliado são só ruído).
export function filtroMaioria(lab, w, h, afinar = true) {
  const out = new Int8Array(lab);
  const cont = new Int32Array(18);
  const usados = new Int32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const own = lab[i];
      let nu = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const v = lab[yy * w + xx] + 1;
          if (cont[v] === 0) usados[nu++] = v;
          cont[v]++;
        }
      }
      const ownC = cont[own + 1];
      if (ownC < 9) {
        let bv = -1, bc = 0;
        for (let k = 0; k < nu; k++) { const v = usados[k]; if (v !== own + 1 && cont[v] > bc) { bc = cont[v]; bv = v; } }
        if (bc >= 5 || ownC <= 2 || (afinar && ownC === 3 && bc >= 3)) out[i] = bv - 1;
      }
      for (let k = 0; k < nu; k++) cont[usados[k]] = 0;
    }
  }
  return out;
}

// Remove "franjas": faixas de 1–2 px de uma cor que é MISTURA de duas cores vizinhas
// (ex.: cinza entre preto e branco, verde-claro entre verde-escuro e laranja).
// Pixel sem "miolo" (3x3 da própria cor) por perto e cuja cor é mistura de duas cores com miolo
// ali perto (até 3 px) vai para a mais parecida dessas duas — a borda fica no lugar certo.
export function removerFinos(lab, w, h, rgba, coresRGB) {
  const N = w * h;
  const K = coresRGB.length;
  // quais cores são mistura de quais pares (pré-calculado)
  const mistura = new Map(); // chave L*64 + A*8... usamos string simples
  const ehMistura = (L, A, B) => {
    const key = L + ',' + A + ',' + B;
    if (!mistura.has(key)) mistura.set(key, misturaDe(coresRGB[L], coresRGB[A], coresRGB[B]));
    return mistura.get(key);
  };
  const nucleo = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, L = lab[i];
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          if (lab[yy * w + xx] !== L) { ok = false; break; }
        }
      }
      nucleo[i] = ok ? 1 : 0;
    }
  }
  // 1) marca pixels de franja e o par de cores (A,B) de que são mistura; voto = lado escolhido pela cor do pixel
  const parDe = new Int16Array(N).fill(-1); // a*16+b
  const voto = new Int8Array(N).fill(-1);
  const presentes = new Uint8Array(K);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const L = lab[i];
      if (nucleo[i] || L < 0) continue;
      let mantem = false;
      for (let dy = -1; dy <= 1 && !mantem; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (nucleo[j] && lab[j] === L) { mantem = true; break; }
        }
      }
      if (mantem) continue;
      presentes.fill(0);
      for (let dy = -3; dy <= 3; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (nucleo[j] && lab[j] >= 0 && lab[j] !== L) presentes[lab[j]] = 1;
        }
      }
      let A = -1, B = -1, melhorT = 0, melhorRes = Infinity;
      const o = i * 4;
      for (let a = 0; a < K; a++) {
        if (!presentes[a]) continue;
        for (let b = a + 1; b < K; b++) {
          if (!presentes[b] || !ehMistura(L, a, b)) continue;
          const ca = coresRGB[a], cb = coresRGB[b];
          const sx = cb[0] - ca[0], sy = cb[1] - ca[1], sz = cb[2] - ca[2];
          const L2 = sx * sx + sy * sy + sz * sz;
          const t = ((rgba[o] - ca[0]) * sx + (rgba[o + 1] - ca[1]) * sy + (rgba[o + 2] - ca[2]) * sz) / L2;
          const ex = rgba[o] - (ca[0] + t * sx), ey = rgba[o + 1] - (ca[1] + t * sy), ez = rgba[o + 2] - (ca[2] + t * sz);
          const res = ex * ex + ey * ey + ez * ez;
          if (res < melhorRes) { melhorRes = res; A = a; B = b; melhorT = t; }
        }
      }
      if (A >= 0) { parDe[i] = A * 16 + B; voto[i] = melhorT < 0.5 ? A : B; }
    }
  }
  // 2) cada faixa contínua (mesma cor, mesmo par) vai inteira para o lado mais votado — borda lisa, sem serrilhar
  const out = new Int8Array(lab);
  const visto = new Uint8Array(N);
  const pilha = new Int32Array(N);
  const votos = new Int32Array(K);
  for (let s0 = 0; s0 < N; s0++) {
    if (parDe[s0] < 0 || visto[s0]) continue;
    const L = lab[s0], P = parDe[s0];
    let topo = 0, fim = 0;
    pilha[fim++] = s0; visto[s0] = 1;
    votos.fill(0);
    while (topo < fim) {
      const p = pilha[topo++];
      votos[voto[p]]++;
      const x = p % w, y = (p - x) / w;
      if (x > 0) { const q = p - 1; if (!visto[q] && parDe[q] === P && lab[q] === L) { visto[q] = 1; pilha[fim++] = q; } }
      if (x < w - 1) { const q = p + 1; if (!visto[q] && parDe[q] === P && lab[q] === L) { visto[q] = 1; pilha[fim++] = q; } }
      if (y > 0) { const q = p - w; if (!visto[q] && parDe[q] === P && lab[q] === L) { visto[q] = 1; pilha[fim++] = q; } }
      if (y < h - 1) { const q = p + w; if (!visto[q] && parDe[q] === P && lab[q] === L) { visto[q] = 1; pilha[fim++] = q; } }
    }
    const a = (P / 16) | 0, b = P % 16;
    const alvo = votos[a] >= votos[b] ? a : b;
    for (let k = 0; k < fim; k++) out[pilha[k]] = alvo;
  }
  return out;
}

// Remove manchas (componentes menores que areaMin), incluindo furinhos transparentes.
// op.coresLab: manchas de cor PARECIDA com a vizinha (ex.: pontinhos marrons no texto verde, por
//   causa da compressão do JPG) são removidas com limite de área maior.
// op.espessuraMin (px de trabalho) + op.coresRGB: tira "franjas" — faixas finíssimas de uma cor que é
//   mistura das duas cores vizinhas (ex.: contorno cinza entre preto e branco). Largura média = 2·área/perímetro.
export function removerManchas(lab, w, h, areaMin, op = {}) {
  const { coresLab = null, coresRGB = null, rgbTransparente = null, fatorMax = 6, distRef = 0.3, espessuraMin = 0 } = op;
  if (areaMin <= 1 && !espessuraMin) return lab;
  const N = w * h;
  const visto = new Uint8Array(N);
  const pilha = new Int32Array(N);
  const viz = new Int32Array(18);
  const corDe = (v) => (v < 0 ? rgbTransparente : coresRGB ? coresRGB[v] : null);
  const ehMistura = (L, A, B) => {
    const c = corDe(L), ca = corDe(A), cb = corDe(B);
    return !!(c && ca && cb) && misturaDe(c, ca, cb);
  };
  for (let s = 0; s < N; s++) {
    if (visto[s]) continue;
    const L = lab[s];
    let topo = 0, fim = 0, perim = 0, total = 0;
    viz.fill(0);
    pilha[fim++] = s; visto[s] = 1;
    while (topo < fim) {
      const p = pilha[topo++];
      const x = p % w, y = (p - x) / w;
      if (x > 0) { const q = p - 1, v = lab[q]; if (v === L) { if (!visto[q]) { visto[q] = 1; pilha[fim++] = q; } } else { viz[v + 1]++; total++; perim++; } } else perim++;
      if (x < w - 1) { const q = p + 1, v = lab[q]; if (v === L) { if (!visto[q]) { visto[q] = 1; pilha[fim++] = q; } } else { viz[v + 1]++; total++; perim++; } } else perim++;
      if (y > 0) { const q = p - w, v = lab[q]; if (v === L) { if (!visto[q]) { visto[q] = 1; pilha[fim++] = q; } } else { viz[v + 1]++; total++; perim++; } } else perim++;
      if (y < h - 1) { const q = p + w, v = lab[q]; if (v === L) { if (!visto[q]) { visto[q] = 1; pilha[fim++] = q; } } else { viz[v + 1]++; total++; perim++; } } else perim++;
    }
    if (!total) continue;
    let bv = -1, bc = 0, bvNT = -1, bcNT = 0, v2 = -2, c2 = 0;
    for (let v = 0; v < 18; v++) {
      const c = viz[v];
      if (c > bc) { v2 = bv; c2 = bc; bc = c; bv = v - 1; } else if (c > c2) { c2 = c; v2 = v - 1; }
      if (v > 0 && c > bcNT) { bcNT = c; bvNT = v - 1; }
    }
    const alvo = bvNT >= 0 && bcNT >= 0.3 * total ? bvNT : bv;
    let fator = 1;
    if (coresLab && L >= 0 && alvo >= 0) {
      const d = Math.sqrt(dist2Lab(coresLab[L], coresLab[alvo]));
      fator = Math.min(fatorMax, 1 + (fatorMax - 1) * Math.max(0, Math.min(1, 1 - d / distRef)));
    }
    const pequena = fim < areaMin * fator;
    const franja = !pequena && espessuraMin > 0 && L >= 0 && v2 > -2 && c2 >= 0.2 * total &&
      (2 * fim) / perim < espessuraMin && ehMistura(L, bv, v2);
    if (pequena || franja) for (let k = 0; k < fim; k++) lab[pilha[k]] = alvo;
  }
  return lab;
}


// Detecta a cor de fundo pela borda da imagem e remove conforme o modo:
// 'auto'    = fundo de fora + miolos fechados por uma única cor (ex.: miolo do "O")
// 'externo' = só o fundo ligado às bordas
// 'cor'     = essa cor em toda a arte
// 'manter'  = não remove
export function removerFundo(lab, w, h, modo = 'auto', coresRGB = null) {
  if (modo === 'manter') return { classe: -1 };
  const cont = new Map();
  let tot = 0;
  const conta = (i) => { const v = lab[i]; if (v >= 0) { cont.set(v, (cont.get(v) || 0) + 1); tot++; } };
  for (let x = 0; x < w; x++) { conta(x); conta((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { conta(y * w); conta(y * w + w - 1); }
  if (!tot) return { classe: -1 };
  let L = -1, c = 0;
  for (const [k, v] of cont) if (v > c) { c = v; L = k; }
  if (c / tot < 0.5) return { classe: -1 };
  const N = w * h;
  if (modo === 'cor') {
    for (let i = 0; i < N; i++) if (lab[i] === L) lab[i] = -1;
    return { classe: L };
  }
  const pilha = new Int32Array(N);
  let fim = 0;
  const semente = (i) => { if (lab[i] === L) { lab[i] = -1; pilha[fim++] = i; } };
  for (let x = 0; x < w; x++) { semente(x); semente((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { semente(y * w); semente(y * w + w - 1); }
  let topo = 0;
  while (topo < fim) {
    const p = pilha[topo++];
    const x = p % w, y = (p - x) / w;
    if (x > 0 && lab[p - 1] === L) { lab[p - 1] = -1; pilha[fim++] = p - 1; }
    if (x < w - 1 && lab[p + 1] === L) { lab[p + 1] = -1; pilha[fim++] = p + 1; }
    if (y > 0 && lab[p - w] === L) { lab[p - w] = -1; pilha[fim++] = p - w; }
    if (y < h - 1 && lab[p + w] === L) { lab[p + w] = -1; pilha[fim++] = p + w; }
  }
  let miolos = 0;
  if (modo === 'auto') {
    const visto = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      if (lab[s] !== L || visto[s]) continue;
      fim = 0; topo = 0;
      pilha[fim++] = s; visto[s] = 1;
      const vizinhas = new Map();
      let contatos = 0;
      while (topo < fim) {
        const p = pilha[topo++];
        const x = p % w, y = (p - x) / w;
        const testa = (q) => {
          const v = lab[q];
          if (v === L) { if (!visto[q]) { visto[q] = 1; pilha[fim++] = q; } }
          else if (v >= 0) { vizinhas.set(v, (vizinhas.get(v) || 0) + 1); contatos++; }
        };
        if (x > 0) testa(p - 1);
        if (x < w - 1) testa(p + 1);
        if (y > 0) testa(p - w);
        if (y < h - 1) testa(p + w);
      }
      // conta só as cores que encostam de verdade (ignora franjinhas de borda)
      let sig = [];
      for (const [cor, c] of vizinhas) if (c >= contatos * 0.1) sig.push(cor);
      if (sig.length >= 2 && coresRGB) {
        // cor que é só mistura do miolo com outra vizinha (ex.: cinza entre branco e preto) não conta
        sig = sig.filter((m) => !sig.some((a) => a !== m && misturaDe(coresRGB[m], coresRGB[L], coresRGB[a])));
      }
      if (sig.length <= 1) { for (let k = 0; k < fim; k++) lab[pilha[k]] = -1; miolos++; }
    }
  }
  return { classe: L, miolos };
}

/* ========================== Traçado ========================== */
function pontoNoPoligono(px, py, pts) {
  let dentro = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function curvaParaSubpath(curve, sx, sy) {
  const n = curve.n, c = curve.c;
  const ini = c[(n - 1) * 3 + 2];
  const segs = [];
  for (let i = 0; i < n; i++) {
    if (curve.tag[i] === 'CURVE') {
      segs.push(['C', c[i * 3].x * sx, c[i * 3].y * sy, c[i * 3 + 1].x * sx, c[i * 3 + 1].y * sy, c[i * 3 + 2].x * sx, c[i * 3 + 2].y * sy]);
    } else {
      segs.push(['L', c[i * 3 + 1].x * sx, c[i * 3 + 1].y * sy]);
      segs.push(['L', c[i * 3 + 2].x * sx, c[i * 3 + 2].y * sy]);
    }
  }
  return { x0: ini.x * sx, y0: ini.y * sy, segs };
}

// Suaviza a borda de uma máscara binária (desfoque gaussiano + corte em 50%).
// Tira o "serrilhado" que o JPG deixa na borda sem mudar o desenho. Preserva aninhamento de máscaras.
export function suavizarMascara(mask, w, h, sigma) {
  if (!(sigma > 0.35)) return mask;
  const r = Math.ceil(sigma * 2.5);
  const k = new Float32Array(2 * r + 1);
  let soma = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); soma += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= soma;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const lin = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) {
        const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j;
        acc += mask[lin + xx] * k[j + r];
      }
      tmp[lin + x] = acc;
    }
  }
  const out = new Int8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) {
        const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j;
        acc += tmp[yy * w + x] * k[j + r];
      }
      out[y * w + x] = acc >= 0.5 ? 1 : 0;
    }
  }
  return out;
}

// Traça uma máscara binária (Uint8/Int8 0/1) e devolve formas = [subpaths] (contorno + furos).
export function tracarMascara(mask, w, h, op, sx, sy) {
  const bmp = new Bitmap(w, h);
  bmp.data = mask instanceof Int8Array ? mask : Int8Array.from(mask);
  const paths = bitmapToPathList(bmp, { turdsize: op.turdsize, turnpolicy: op.turnpolicy || 'minority' });
  processPath(paths, { alphamax: op.alphamax, optcurve: op.optcurve !== false, opttolerance: op.opttolerance });
  const externos = [], furos = [];
  for (const p of paths) (p.isHole ? furos : externos).push(p);
  const formas = externos.map((p) => ({ p, subs: [curvaParaSubpath(p.curve, sx, sy)], area: (p.maxX - p.minX) * (p.maxY - p.minY) }));
  for (const f of furos) {
    const tx = f.points[0].x + 0.5, ty = f.points[0].y + 0.5;
    let melhor = null;
    for (const e of formas) {
      const q = e.p;
      if (q.minX > f.minX || q.maxX < f.maxX || q.minY > f.minY || q.maxY < f.maxY) continue;
      if (melhor && e.area >= melhor.area) continue;
      if (pontoNoPoligono(tx, ty, q.points)) melhor = e;
    }
    const sp = curvaParaSubpath(f.curve, sx, sy);
    if (melhor) melhor.subs.push(sp);
    else formas.push({ p: f, subs: [sp], area: 0 });
  }
  return formas.map((e) => e.subs);
}

// Máscara "empilhada" de uma cor: a própria cor + uma faixa de d px por baixo das cores de cima
// que encostam nela (cobre a emenda, sem fresta) + furos que só têm cores de cima (sem buraco por baixo).
// Não copia elementos de cima que não encostam (ex.: letras soltas) — nada de cópias escondidas no Illustrator.
export function mascaraEmpilhada(lab, w, h, k, rank, d) {
  const N = w * h;
  const mask = new Int8Array(N);
  const dist = new Int16Array(N).fill(-1);
  const fila = new Int32Array(N);
  const rk = rank[k];
  const acima = (v) => v >= 0 && rank[v] > rk;
  let ini = 0, fim = 0;
  for (let i = 0; i < N; i++) if (lab[i] === k) { mask[i] = 1; dist[i] = 0; fila[fim++] = i; }
  while (ini < fim) {
    const p = fila[ini++];
    const dp = dist[p];
    if (dp >= d) continue;
    const x = p % w, y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
        const q = yy * w + xx;
        if (dist[q] !== -1 || !acima(lab[q])) continue;
        dist[q] = dp + 1; mask[q] = 1; fila[fim++] = q;
      }
    }
  }
  const visto = new Uint8Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (mask[s0] || visto[s0]) continue;
    let a = 0, b = 0, borda = false, soAcima = true;
    fila[b++] = s0; visto[s0] = 1;
    while (a < b) {
      const p = fila[a++];
      const x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) borda = true;
      if (soAcima && !acima(lab[p])) soAcima = false;
      if (x > 0) { const q = p - 1; if (!mask[q] && !visto[q]) { visto[q] = 1; fila[b++] = q; } }
      if (x < w - 1) { const q = p + 1; if (!mask[q] && !visto[q]) { visto[q] = 1; fila[b++] = q; } }
      if (y > 0) { const q = p - w; if (!mask[q] && !visto[q]) { visto[q] = 1; fila[b++] = q; } }
      if (y < h - 1) { const q = p + w; if (!mask[q] && !visto[q]) { visto[q] = 1; fila[b++] = q; } }
    }
    if (!borda && soAcima) for (let t = 0; t < b; t++) mask[fila[t]] = 1;
  }
  return mask;
}

// Monta as camadas (uma por cor) a partir do mapa de rótulos.
// empilhadas: cada camada inclui as camadas de cima (sem frestas entre cores).
export function tracarCamadas(lab, w, h, K, op, progresso) {
  const N = w * h;
  const areas = new Float64Array(K);
  for (let i = 0; i < N; i++) if (lab[i] >= 0) areas[lab[i]]++;
  const ordem = [];
  for (let k = 0; k < K; k++) if (areas[k] > 0) ordem.push(k);
  ordem.sort((a, b) => areas[b] - areas[a]); // maior embaixo
  const res = new Array(ordem.length);
  const rank = new Int16Array(Math.max(K, 1)).fill(-1);
  ordem.forEach((k, pos) => { rank[k] = pos; });
  const sx = op.sx, sy = op.sy;
  const ext = op.extensao || 3;
  for (let n = ordem.length - 1; n >= 0; n--) {
    const k = ordem[n];
    let mask;
    if (op.camadas === 'recortadas') {
      mask = new Int8Array(N);
      for (let i = 0; i < N; i++) if (lab[i] === k) mask[i] = 1;
    } else {
      mask = mascaraEmpilhada(lab, w, h, k, rank, ext);
    }
    if (progresso) progresso(`Traçando cor ${ordem.length - n} de ${ordem.length}`, (ordem.length - n) / ordem.length);
    if (op.sigma) mask = suavizarMascara(mask, w, h, op.sigma);
    res[n] = { classe: k, formas: tracarMascara(mask, w, h, op, sx, sy) };
  }
  return res; // de baixo para cima
}

/* ======================== Saída (SVG/PDF) ======================== */
function fmt(v) {
  const r = Math.round(v * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
}
export function subpathParaD(sp) {
  let d = 'M' + fmt(sp.x0) + ' ' + fmt(sp.y0);
  for (const s of sp.segs) {
    if (s[0] === 'C') d += 'C' + fmt(s[1]) + ' ' + fmt(s[2]) + ' ' + fmt(s[3]) + ' ' + fmt(s[4]) + ' ' + fmt(s[5]) + ' ' + fmt(s[6]);
    else d += 'L' + fmt(s[1]) + ' ' + fmt(s[2]);
  }
  return d + 'Z';
}

// camadas: [{cor:'#RRGGBB', formas:[[subpath...]...]}] de baixo para cima
export function montarSVG(camadas, W, H, titulo = '', comIds = false) {
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<!-- Vetorizador Blooming — gerado sem IA (Potrace/VTracer) -->');
  L.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(W)}" height="${fmt(H)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`);
  if (titulo) L.push(`<title>${String(titulo).replace(/[<&>]/g, '')}</title>`);
  let id = 0;
  camadas.forEach((c, i) => {
    if (!c.formas.length) { return; }
    L.push(`<g id="cor-${i + 1}_${c.cor.replace('#', '')}" fill="${c.cor}">`);
    for (const f of c.formas) {
      id++;
      const extra = (comIds ? ` data-f="${id}"` : '') + (f.cor ? ` fill="${f.cor}"` : '');
      L.push(`<path${extra} fill-rule="evenodd" d="${f.map(subpathParaD).join('')}"/>`);
    }
    L.push('</g>');
  });
  L.push('</svg>');
  return L.join('\n');
}

export function estatisticas(camadas) {
  let formas = 0, nos = 0;
  for (const c of camadas) for (const f of c.formas) { formas++; for (const s of f) nos += s.segs.length; }
  const cores = new Set();
  for (const c of camadas) for (const f of c.formas) cores.add(f.cor || c.cor);
  return { cores: cores.size, formas, nos };
}

// PDF vetorial simples (1 página, RGB). 1 px da imagem = 1 pt.
export function montarPDF(camadas, W, H) {
  const n = (v) => fmt(v);
  let cs = `1 0 0 -1 0 ${n(H)} cm\n`;
  for (const c of camadas) {
    if (!c.formas.length) continue;
    const [r, g, b] = deHex(c.cor);
    cs += `${n(r / 255)} ${n(g / 255)} ${n(b / 255)} rg\n`;
    for (const f of c.formas) {
      if (f.cor) { const [r2, g2, b2] = deHex(f.cor); cs += `${n(r2 / 255)} ${n(g2 / 255)} ${n(b2 / 255)} rg\n`; }
      for (const sp of f) {
        cs += `${n(sp.x0)} ${n(sp.y0)} m\n`;
        for (const s of sp.segs) {
          if (s[0] === 'C') cs += `${n(s[1])} ${n(s[2])} ${n(s[3])} ${n(s[4])} ${n(s[5])} ${n(s[6])} c\n`;
          else cs += `${n(s[1])} ${n(s[2])} l\n`;
        }
        cs += 'h\n';
      }
      cs += 'f*\n';
      if (f.cor) cs += `${n(r / 255)} ${n(g / 255)} ${n(b / 255)} rg\n`;
    }
  }
  const enc = new TextEncoder();
  const corpo = enc.encode(cs);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(W)} ${n(H)}] /Contents 4 0 R /Resources << >> >>`,
  ];
  const partes = [];
  let pos = 0;
  const push = (s) => { const b = typeof s === 'string' ? enc.encode(s) : s; partes.push(b); pos += b.length; };
  push(String.fromCharCode(37) + 'PDF-1.4\n' + String.fromCharCode(37) + '\xE2\xE3\xCF\xD3\n');
  const offs = [];
  objs.forEach((o, i) => { offs.push(pos); push(`${i + 1} 0 obj\n${o}\nendobj\n`); });
  offs.push(pos);
  push(`4 0 obj\n<< /Length ${corpo.length} >>\nstream\n`);
  push(corpo);
  push('\nendstream\nendobj\n');
  const xref = pos;
  let x = `xref\n0 5\n0000000000 65535 f \n`;
  for (const o of offs) x += String(o).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n` + String.fromCharCode(37, 37) + 'EOF\n');
  const out = new Uint8Array(pos);
  let k = 0;
  for (const p of partes) { out.set(p, k); k += p.length; }
  return out;
}

/* ===================== Leitura de SVG (VTracer) ===================== */
// Converte o "d" de um path SVG em subpaths absolutos (M/L/C), para PDF e estatísticas.
export function lerPathD(d, sx = 1, sy = 1, tx = 0, ty = 0) {
  const tok = d.match(/[MmLlHhVvCcSsQqTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const subs = [];
  let i = 0, cmd = '', x = 0, y = 0, x0 = 0, y0 = 0, cx = 0, cy = 0, cur = null, lastC = false, lastQ = false, qx = 0, qy = 0;
  const num = () => parseFloat(tok[i++]);
  const P = (px, py) => [(px + tx) * sx, (py + ty) * sy];
  const C = (x1, y1, x2, y2, x3, y3) => { const a = P(x1, y1), b = P(x2, y2), c = P(x3, y3); cur.segs.push(['C', a[0], a[1], b[0], b[1], c[0], c[1]]); };
  const Lt = (px, py) => { const a = P(px, py); cur.segs.push(['L', a[0], a[1]]); };
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    if (c === 'Z') { if (cur) { x = x0; y = y0; } cur = null; lastC = lastQ = false; continue; }
    if (c === 'M') {
      x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); x0 = x; y0 = y;
      const a = P(x, y); cur = { x0: a[0], y0: a[1], segs: [] }; subs.push(cur);
      cmd = rel ? 'l' : 'L'; lastC = lastQ = false; continue;
    }
    if (!cur) { const a = P(x, y); cur = { x0: a[0], y0: a[1], segs: [] }; subs.push(cur); }
    if (c === 'L') { x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); Lt(x, y); lastC = lastQ = false; }
    else if (c === 'H') { x = (rel ? x : 0) + num(); Lt(x, y); lastC = lastQ = false; }
    else if (c === 'V') { y = (rel ? y : 0) + num(); Lt(x, y); lastC = lastQ = false; }
    else if (c === 'C') {
      const x1 = (rel ? x : 0) + num(), y1 = (rel ? y : 0) + num(), x2 = (rel ? x : 0) + num(), y2 = (rel ? y : 0) + num(), x3 = (rel ? x : 0) + num(), y3 = (rel ? y : 0) + num();
      C(x1, y1, x2, y2, x3, y3); cx = x2; cy = y2; x = x3; y = y3; lastC = true; lastQ = false;
    } else if (c === 'S') {
      const x1 = lastC ? 2 * x - cx : x, y1 = lastC ? 2 * y - cy : y;
      const x2 = (rel ? x : 0) + num(), y2 = (rel ? y : 0) + num(), x3 = (rel ? x : 0) + num(), y3 = (rel ? y : 0) + num();
      C(x1, y1, x2, y2, x3, y3); cx = x2; cy = y2; x = x3; y = y3; lastC = true; lastQ = false;
    } else if (c === 'Q' || c === 'T') {
      let x1, y1;
      if (c === 'Q') { x1 = (rel ? x : 0) + num(); y1 = (rel ? y : 0) + num(); }
      else { x1 = lastQ ? 2 * x - qx : x; y1 = lastQ ? 2 * y - qy : y; }
      const x3 = (rel ? x : 0) + num(), y3 = (rel ? y : 0) + num();
      C(x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x3 + (2 / 3) * (x1 - x3), y3 + (2 / 3) * (y1 - y3), x3, y3);
      qx = x1; qy = y1; x = x3; y = y3; lastQ = true; lastC = false;
    } else { i++; }
  }
  return subs.filter((s) => s.segs.length);
}

// Lê o SVG do VTracer e agrupa as formas por cor (mantendo a ordem de pintura).
export function lerSVGVTracer(svg, sx, sy, mapaCor) {
  const camadas = [];
  const re = /<path\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(svg))) {
    const at = m[1];
    const d = (at.match(/\bd="([^"]*)"/) || [])[1];
    let fill = ((at.match(/\bfill="([^"]*)"/) || [])[1] || '#000000').toUpperCase();
    if (!d || fill === 'NONE') continue;
    let tx = 0, ty = 0;
    const tr = at.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/);
    if (tr) { tx = parseFloat(tr[1]); ty = parseFloat(tr[2]); }
    if (/^#[0-9A-F]{3}$/.test(fill)) fill = '#' + fill.slice(1).split('').map((c) => c + c).join('');
    const cor = mapaCor ? mapaCor(fill) : fill;
    if (cor === null) continue;
    const subs = lerPathD(d, sx, sy, tx, ty);
    if (!subs.length) continue;
    // camadas consecutivas da mesma cor viram um grupo; mantém a ordem de empilhamento
    let ultima = camadas[camadas.length - 1];
    if (!ultima || ultima.cor !== cor) { ultima = { cor, formas: [] }; camadas.push(ultima); }
    ultima.formas.push(subs);
  }
  return camadas;
}

// Imagem RGBA a partir dos rótulos (para alimentar o VTracer com a arte já limpa).
export function rgbaDeRotulos(lab, w, h, cores) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const v = lab[i];
    if (v < 0) continue;
    const c = cores[v];
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }
  return out;
}

/* ======================= Pipeline completo ======================= */
export const PADRAO = {
  modo: 'cores', // 'cores' | 'pb' | 'foto'
  cores: 0,
  fundo: 'auto',
  suavidade: 1.0,
  simplificacao: 0.35,
  detalhe: 2,
  qualidade: 'normal',
  limparRuido: true,
  motor: 'potrace', // 'potrace' | 'vtracer'
  camadas: 'empilhadas',
  limiar: 'auto', // 'auto' | 'adaptativo' | número
  sensibilidade: 15,
  inverter: false,
  corTraco: '#000000',
  fotoCores: 16,
};

// paleta: [{rgb:[r,g,b], saida:'#hex', transparente:bool}]
// vt: objeto com vectorizeRgba(rgba,w,h,opts) ou null
// cache: objeto reutilizável entre chamadas da mesma imagem
export function vetorizar(img, opcoes, paleta, vt, cache = {}, progresso = () => {}) {
  const op = { ...PADRAO, ...opcoes };
  const t0 = Date.now();
  const { w, h } = img;
  const info = {};

  // 1) limpeza de ruído (no tamanho original) — guardado em cache
  let base = img;
  if (op.limparRuido && op.modo !== 'foto') {
    if (!cache.limpa) { progresso('Limpando ruído', 0.05); cache.limpa = suavizarRuido(img); }
    base = cache.limpa;
  }

  if (op.modo === 'foto') {
    if (!vt) throw new Error('VTracer indisponível neste navegador — use o modo Cores.');
    progresso('Traçando (foto/pôster)', 0.3);
    const lado = Math.max(w, h);
    const f = lado < 900 ? 2 : lado > 2000 ? 2000 / lado : 1;
    const W = Math.round(w * f), H = Math.round(h * f);
    const chave = 'foto' + W;
    if (!cache[chave]) cache[chave] = redimensionar(img, W, H);
    const im = cache[chave];
    const svgVT = vt.vectorizeRgba(new Uint8Array(im.rgba.buffer.slice(0)), W, H, {
      preset: 'poster', maxColors: op.fotoCores, filterSpeckle: Math.max(2, Math.round(Math.sqrt(op.detalhe) * f * 2)),
      hierarchical: 'stacked', mode: 'spline', pathPrecision: 2,
    });
    const camadas = lerSVGVTracer(svgVT, w / W, h / H);
    return { camadas, w, h, info: { ...info, tempo: Date.now() - t0, motor: 'vtracer' } };
  }

  // 2) ampliação para traçar com subpixel (bordas suaves)
  const { W, H } = dimensoesDeTrabalho(w, h, op.qualidade);
  const chaveAmp = `amp_${W}x${H}_${op.limparRuido && 1}`;
  if (!cache[chaveAmp]) { progresso('Ampliando', 0.15); cache[chaveAmp] = redimensionar(base, W, H); }
  const amp = cache[chaveAmp];
  const sx = w / W, sy = h / H;
  const f = W / w;
  info.trabalho = `${W}×${H}`;
  const escalaMancha = Math.max(f * f, (Math.max(W, H) / 500) ** 2);
  const areaMin = Math.max(2, Math.round(op.detalhe * escalaMancha));

  let lab, cores, K;
  progresso('Separando cores', 0.3);
  if (op.modo === 'pb') {
    const lim = typeof op.limiar === 'number' ? 'manual' : op.limiar;
    const r = classificarPB(amp, lim, typeof op.limiar === 'number' ? op.limiar : 128, op.inverter, op.sensibilidade);
    lab = r.lab; info.limiar = r.limiar;
    cores = [deHex(op.corTraco)]; K = 1;
    lab = filtroMaioria(lab, W, H, f >= 2);
    removerManchas(lab, W, H, areaMin);
    lab = filtroMaioria(lab, W, H, f >= 2);
  } else {
    const centros = paleta.map((p) => p.rgb);
    K = centros.length;
    // separação de cores fica em cache: mexer em fundo/suavidade/manchas/cores de saída não refaz esta parte
    const chaveCls = [chaveAmp, op.semContexto ? 0 : 1, op.semFinos ? 0 : 1, centros.map((c) => c.join(',')).join(';')].join('|');
    if (cache.clsChave !== chaveCls) {
      let l = classificar(amp, centros, op.semContexto ? 0 : Math.max(2, 1.5 * f));
      l = filtroMaioria(l, W, H, f >= 2);
      if (f >= 3 && !op.semFinos) l = removerFinos(l, W, H, amp.rgba, centros);
      cache.cls = l; cache.clsChave = chaveCls;
    }
    lab = new Int8Array(cache.cls);
    const destino = paleta.map((p, i) => (Number.isInteger(p.fundirEm) && p.fundirEm >= 0 && p.fundirEm < paleta.length && p.fundirEm !== i ? p.fundirEm : i));
    for (let k = 0; k < destino.length; k++) { let d = destino[k], n = 0; while (destino[d] !== d && n++ < 20) d = destino[d]; destino[k] = d; }
    if (destino.some((d, i) => d !== i)) for (let i = 0; i < lab.length; i++) if (lab[i] >= 0) lab[i] = destino[lab[i]];
    const transp = paleta.map((p) => !!p.transparente);
    if (transp.some(Boolean)) for (let i = 0; i < lab.length; i++) if (lab[i] >= 0 && transp[lab[i]]) lab[i] = -1;
    const fundo = removerFundo(lab, W, H, op.fundo, centros);
    info.classeFundo = fundo.classe;
    removerManchas(lab, W, H, areaMin, {
      coresLab: centros.map((c) => rgbParaOklab(c[0], c[1], c[2])),
      coresRGB: centros,
      rgbTransparente: fundo.classe >= 0 ? centros[fundo.classe] : null,
      espessuraMin: f >= 2 ? 0.9 * f : 0,
    });
    lab = filtroMaioria(lab, W, H, f >= 2);
    cores = paleta.map((p) => deHex(p.saida || paraHex(p.rgb)));
  }

  // 3) traçado
  let camadas;
  if (op.motor === 'vtracer' && vt) {
    progresso('Traçando (VTracer)', 0.6);
    const rgbaL = rgbaDeRotulos(lab, W, H, cores);
    const hexes = [...new Set(cores.map(paraHex))];
    const svgVT = vt.vectorizeRgba(rgbaL, W, H, {
      palette: hexes, hierarchical: op.camadas === 'recortadas' ? 'cutout' : 'stacked', mode: 'spline',
      filterSpeckle: Math.max(1, Math.round(Math.sqrt(areaMin))), cornerThreshold: 60, lengthThreshold: 4,
      spliceThreshold: 45, pathPrecision: 2, simplify: Math.max(0.5, op.simplificacao * f * 2),
    });
    camadas = lerSVGVTracer(svgVT, sx, sy);
    info.motor = 'vtracer';
  } else {
    // "Suavidade" controla os cantos (alphamax) e o alisamento da borda (σ em pixels da imagem original)
    const sigmaOrig = Math.min(0.45, Math.max(0, (op.suavidade - 0.6) * 0.9)); // teto: não quebra traço fino
    const potOp = {
      turdsize: areaMin, alphamax: op.suavidade, opttolerance: Math.max(0.2, op.simplificacao * f),
      optcurve: true, turnpolicy: 'minority', camadas: op.camadas, sx, sy,
      sigma: f >= 1.5 ? sigmaOrig * f : 0,
      extensao: Math.max(2, Math.ceil(0.5 * f + 1)),
    };
    const res = tracarCamadas(lab, W, H, K, potOp, (m, p) => progresso(m, 0.35 + 0.6 * p));
    camadas = res.map((r) => ({ cor: paraHex(cores[r.classe]), classe: r.classe, formas: r.formas }));
    info.motor = 'potrace';
  }
  info.tempo = Date.now() - t0;
  return { camadas, w, h, info, lab, W, H };
}

/* =================== Formas: análise e ajustes geométricos =================== */
// Ferramentas determinísticas (sem IA): a IA (ou o usuário) só escolhe ONDE aplicar.
const KAPPA = 0.5522847498;

export function amostrarSubpath(sp, passo = 1.5) {
  const pts = [[sp.x0, sp.y0]];
  let x = sp.x0, y = sp.y0;
  for (const s of sp.segs) {
    if (s[0] === 'L') { x = s[1]; y = s[2]; pts.push([x, y]); continue; }
    const x1 = s[1], y1 = s[2], x2 = s[3], y2 = s[4], x3 = s[5], y3 = s[6];
    const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.max(2, Math.min(64, Math.ceil(len / passo)));
    for (let k = 1; k <= n; k++) {
      const t = k / n, mt = 1 - t;
      const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
      pts.push([a * x + b * x1 + c * x2 + d * x3, a * y + b * y1 + c * y2 + d * y3]);
    }
    x = x3; y = y3;
  }
  return pts;
}

// área (com sinal), centroide e momentos centrais de 2ª ordem de um polígono fechado
function momentos(pts) {
  let A = 0, cx = 0, cy = 0, sxx = 0, syy = 0, sxy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const cr = p[0] * q[1] - q[0] * p[1];
    A += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
    sxx += (p[0] * p[0] + p[0] * q[0] + q[0] * q[0]) * cr;
    syy += (p[1] * p[1] + p[1] * q[1] + q[1] * q[1]) * cr;
    sxy += (p[0] * q[1] + 2 * p[0] * p[1] + 2 * q[0] * q[1] + q[0] * p[1]) * cr;
  }
  A /= 2;
  if (Math.abs(A) < 1e-9) return { A: 0, cx: pts[0][0], cy: pts[0][1], Ixx: 0, Iyy: 0, Ixy: 0 };
  cx /= 6 * A; cy /= 6 * A;
  return { A, cx, cy, Ixx: sxx / 12 / A - cx * cx, Iyy: syy / 12 / A - cy * cy, Ixy: sxy / 24 / A - cx * cy };
}

const ANG_RETO = (3 * Math.PI) / 180;
function angPrincipal(m) {
  let th = 0.5 * Math.atan2(2 * m.Ixy, m.Ixx - m.Iyy);
  // quase alinhado aos eixos? endireita
  for (const alvo of [0, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI]) if (Math.abs(th - alvo) < ANG_RETO) th = alvo;
  return th;
}

function ajusteElipse(pts) {
  const m = momentos(pts);
  const tr = (m.Ixx + m.Iyy) / 2, df = Math.sqrt(((m.Ixx - m.Iyy) / 2) ** 2 + m.Ixy ** 2);
  const l1 = Math.max(1e-9, tr + df), l2 = Math.max(1e-9, tr - df);
  return { cx: m.cx, cy: m.cy, a: 2 * Math.sqrt(l1), b: 2 * Math.sqrt(l2), th: angPrincipal(m), A: Math.abs(m.A) };
}

// ângulo do retângulo: o que dá a menor caixa (funciona até para quadrado, onde os momentos não dizem nada)
function anguloMenorCaixa(pts) {
  let melhor = 0, menor = Infinity;
  const passo = Math.max(1, Math.floor(pts.length / 400));
  for (let g = 0; g < 90; g += 0.5) {
    const t = (g * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < pts.length; i += passo) {
      const [x, y] = pts[i];
      const u = x * c + y * s, v = -x * s + y * c;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const a = (u1 - u0) * (v1 - v0);
    if (a < menor - 1e-9) { menor = a; melhor = t; }
  }
  if (melhor < ANG_RETO || Math.PI / 2 - melhor < ANG_RETO) melhor = 0;
  return melhor;
}
function ajusteRetangulo(pts) {
  const m = momentos(pts);
  const th = anguloMenorCaixa(pts);
  const c = Math.cos(th), s = Math.sin(th);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of pts) {
    const u = x * c + y * s, v = -x * s + y * c;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const w = u1 - u0, h = v1 - v0;
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const deficit = Math.max(0, w * h - Math.abs(m.A));
  const r = Math.min(Math.sqrt(deficit / (4 - Math.PI)), Math.min(w, h) / 2);
  return { cx: uc * c - vc * s, cy: uc * s + vc * c, w, h, th, r: r < Math.min(w, h) * 0.02 ? 0 : r };
}

function erroCirculo(pts, e) {
  const r = Math.sqrt(e.A / Math.PI);
  let s = 0;
  for (const [x, y] of pts) s += Math.abs(Math.hypot(x - e.cx, y - e.cy) - r);
  return s / pts.length / Math.max(r, 1e-9);
}
function erroElipse(pts, e) {
  const c = Math.cos(e.th), s = Math.sin(e.th);
  let t = 0;
  for (const [x, y] of pts) {
    const dx = x - e.cx, dy = y - e.cy;
    const u = (dx * c + dy * s) / e.a, v = (-dx * s + dy * c) / e.b;
    t += Math.abs(Math.hypot(u, v) - 1);
  }
  return t / pts.length;
}
function erroRetangulo(pts, R) {
  const c = Math.cos(R.th), s = Math.sin(R.th);
  const hw = R.w / 2 - R.r, hh = R.h / 2 - R.r;
  let t = 0;
  for (const [x, y] of pts) {
    const dx = x - R.cx, dy = y - R.cy;
    const qx = Math.abs(dx * c + dy * s) - hw, qy = Math.abs(-dx * s + dy * c) - hh;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R.r;
    t += Math.abs(d);
  }
  return t / pts.length / Math.max(1e-9, Math.min(R.w, R.h));
}

// ---- ajustes robustos (ignoram "calombos" de outras cores que entram na silhueta empilhada) ----
function resolver(Mx, bv) {
  const n = bv.length;
  const A = Mx.map((r, i) => [...r, bv[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((r, i) => r[n] / r[i]);
}
function mediana(v) { const a = v.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; }

export function circuloRobusto(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let usar = pts.map(([x, y]) => [x - mx, y - my]);
  let c = null;
  for (let it = 0; it < 4; it++) {
    let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0;
    for (const [x, y] of usar) { const z = x * x + y * y; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sz += z; sxz += x * z; syz += y * z; }
    const sol = resolver([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, usar.length]], [-sxz, -syz, -sz]);
    if (!sol) break;
    const cx = -sol[0] / 2, cy = -sol[1] / 2, r = Math.sqrt(Math.max(0, cx * cx + cy * cy - sol[2]));
    c = { cx, cy, r };
    const todos = pts.map(([x, y]) => Math.abs(Math.hypot(x - mx - cx, y - my - cy) - r));
    const lim = Math.max(2.5 * mediana(todos), r * 0.004);
    const novos = pts.map(([x, y]) => [x - mx, y - my]).filter((q, i) => todos[i] <= lim);
    if (novos.length < 8 || novos.length === usar.length) break;
    usar = novos;
  }
  if (!c) return null;
  const res = pts.map(([x, y]) => Math.abs(Math.hypot(x - mx - c.cx, y - my - c.cy) - c.r));
  const erro = mediana(res) / Math.max(c.r, 1e-9);
  const dentro = res.filter((d) => d <= Math.max(0.03 * c.r, 1)).length / pts.length;
  return { cx: c.cx + mx, cy: c.cy + my, a: c.r, b: c.r, th: 0, erro, dentro };
}

export function elipseRobusta(pts) {
  const e0 = ajusteElipse(pts);
  const th = e0.th, co = Math.cos(th), si = Math.sin(th);
  const loc = pts.map(([x, y]) => { const dx = x - e0.cx, dy = y - e0.cy; return [dx * co + dy * si, -dx * si + dy * co]; });
  let e = { u0: 0, v0: 0, a: e0.a, b: e0.b };
  let usar = loc;
  for (let it = 0; it < 4; it++) {
    // A u² + C v² + D u + E v = 1
    const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], bv = [0, 0, 0, 0];
    for (const [u, v] of usar) {
      const f = [u * u, v * v, u, v];
      for (let i = 0; i < 4; i++) { bv[i] += f[i]; for (let j = 0; j < 4; j++) M[i][j] += f[i] * f[j]; }
    }
    const sol = resolver(M, bv);
    if (!sol || sol[0] <= 0 || sol[1] <= 0) break;
    const [A, C, D, E] = sol;
    const u0 = -D / (2 * A), v0 = -E / (2 * C);
    const G = 1 + A * u0 * u0 + C * v0 * v0;
    if (G <= 0) break;
    e = { u0, v0, a: Math.sqrt(G / A), b: Math.sqrt(G / C) };
    const todos = loc.map(([u, v]) => Math.abs(Math.hypot((u - e.u0) / e.a, (v - e.v0) / e.b) - 1));
    const lim = Math.max(2.5 * mediana(todos), 0.004);
    const novos = loc.filter((q, i) => todos[i] <= lim);
    if (novos.length < 10 || novos.length === usar.length) break;
    usar = novos;
  }
  const res = loc.map(([u, v]) => Math.abs(Math.hypot((u - e.u0) / e.a, (v - e.v0) / e.b) - 1));
  return {
    cx: e0.cx + e.u0 * co - e.v0 * si, cy: e0.cy + e.u0 * si + e.v0 * co, a: e.a, b: e.b, th,
    erro: mediana(res), dentro: res.filter((d) => d <= 0.03).length / pts.length,
  };
}

export function retanguloRobusto(pts) {
  const R = ajusteRetangulo(pts);
  const co = Math.cos(R.th), si = Math.sin(R.th);
  const loc = pts.map(([x, y]) => { const dx = x - R.cx, dy = y - R.cy; return [dx * co + dy * si, -dx * si + dy * co]; });
  // cada lado = mediana dos pontos que estão "naquele lado" (fora dos cantos)
  const hw = R.w / 2, hh = R.h / 2;
  const lados = { d: [], e: [], b: [], c: [] };
  for (const [u, v] of loc) {
    const fu = Math.abs(u) / hw, fv = Math.abs(v) / hh;
    if (fu > fv && Math.abs(v) < hh * 0.7) (u > 0 ? lados.d : lados.e).push(u);
    else if (fv > fu && Math.abs(u) < hw * 0.7) (v > 0 ? lados.b : lados.c).push(v);
  }
  const ud = lados.d.length > 3 ? mediana(lados.d) : hw, ue = lados.e.length > 3 ? mediana(lados.e) : -hw;
  const vb = lados.b.length > 3 ? mediana(lados.b) : hh, vc = lados.c.length > 3 ? mediana(lados.c) : -hh;
  const w = ud - ue, h = vb - vc, uc = (ud + ue) / 2, vcen = (vb + vc) / 2;
  const out = { cx: R.cx + uc * co - vcen * si, cy: R.cy + uc * si + vcen * co, w, h, th: R.th, r: Math.min(R.r, Math.min(w, h) / 2) };
  const res = [];
  const hw2 = w / 2 - out.r, hh2 = h / 2 - out.r;
  for (const [u0, v0] of loc) {
    const qx = Math.abs(u0 - uc) - hw2, qy = Math.abs(v0 - vcen) - hh2;
    res.push(Math.abs(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - out.r));
  }
  const m = Math.max(1e-9, Math.min(w, h));
  out.erro = mediana(res) / m;
  out.dentro = res.filter((d) => d <= Math.max(0.03 * m, 1)).length / pts.length;
  return out;
}

// Anel (ou disco) a partir de pedaços: junta os contornos de vários pedaços (ex.: anel cortado por folhas),
// separa raio de fora e de dentro e devolve círculos concêntricos. null se não parecer anel/disco.
export function ajustarAnel(subs) {
  const pts = [];
  for (const sp of subs) for (const p of amostrarSubpath(sp, 1.5)) pts.push(p);
  if (pts.length < 20) return null;
  const c0 = circuloRobusto(pts);
  if (!c0) return null;
  const d = pts.map(([x, y]) => Math.hypot(x - c0.cx, y - c0.cy));
  let a = Math.min(...d.slice(0, 1)), b = 0;
  for (const v of d) { if (v < a) a = v; if (v > b) b = v; }
  for (let it = 0; it < 12; it++) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (const v of d) { if (Math.abs(v - a) < Math.abs(v - b)) { sa += v; na++; } else { sb += v; nb++; } }
    if (na) a = sa / na; if (nb) b = sb / nb;
  }
  const ext = [], int = [];
  pts.forEach((p, i) => (Math.abs(d[i] - a) < Math.abs(d[i] - b) ? int : ext).push(p));
  const co = circuloRobusto(ext.length >= 12 ? ext : pts);
  if (!co || co.erro > 0.03) return null;
  if (int.length < 0.12 * pts.length || b - a < 0.05 * b) return { tipo: 'disco', cx: co.cx, cy: co.cy, r: co.a, erro: co.erro };
  const ci = circuloRobusto(int);
  if (!ci || ci.erro > 0.04 || ci.a >= co.a * 0.97) return { tipo: 'disco', cx: co.cx, cy: co.cy, r: co.a, erro: co.erro };
  const cx = (co.cx * ext.length + ci.cx * int.length) / pts.length, cy = (co.cy * ext.length + ci.cy * int.length) / pts.length;
  return { tipo: 'anel', cx, cy, rFora: co.a, rDentro: ci.a, erro: Math.max(co.erro, ci.erro) };
}

export function subpathElipse(cx, cy, a, b, th = 0) {
  const c = Math.cos(th), s = Math.sin(th);
  const P = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
  const k = KAPPA;
  const q = [[a, k * b, k * a, b, 0, b], [-k * a, b, -a, k * b, -a, 0], [-a, -k * b, -k * a, -b, 0, -b], [k * a, -b, a, -k * b, a, 0]];
  const p0 = P(a, 0);
  return { x0: p0[0], y0: p0[1], segs: q.map((v) => { const c1 = P(v[0], v[1]), c2 = P(v[2], v[3]), e = P(v[4], v[5]); return ['C', c1[0], c1[1], c2[0], c2[1], e[0], e[1]]; }) };
}

export function subpathRetangulo(cx, cy, w, h, th = 0, r = 0) {
  const c = Math.cos(th), s = Math.sin(th);
  const P = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
  const hw = w / 2, hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  const k = KAPPA * r;
  const segs = [];
  const L = (x, y) => { const p = P(x, y); segs.push(['L', p[0], p[1]]); };
  const C = (x1, y1, x2, y2, x, y) => { const a = P(x1, y1), b = P(x2, y2), e = P(x, y); segs.push(['C', a[0], a[1], b[0], b[1], e[0], e[1]]); };
  const ini = P(-hw + r, -hh);
  L(hw - r, -hh);
  if (r > 0) C(hw - r + k, -hh, hw, -hh + r - k, hw, -hh + r);
  L(hw, hh - r);
  if (r > 0) C(hw, hh - r + k, hw - r + k, hh, hw - r, hh);
  L(-hw + r, hh);
  if (r > 0) C(-hw + r - k, hh, -hw, hh - r + k, -hw, hh - r);
  L(-hw, -hh + r);
  if (r > 0) C(-hw, -hh + r - k, -hw + r - k, -hh, -hw + r, -hh);
  return { x0: ini[0], y0: ini[1], segs };
}

function distPontoReta(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * dy - (py - ay) * dx) / L;
}

// Curvas quase retas viram retas, retas seguidas na mesma direção viram uma só,
// quase horizontal/vertical fica exata.
export function endireitarSubpath(sp, tol) {
  const P = [[sp.x0, sp.y0]];
  const S = []; // segmentos: {c: [x1,y1,x2,y2] | null}
  for (const s of sp.segs) {
    const a = P[P.length - 1];
    if (s[0] === 'C') {
      const reta = Math.max(distPontoReta(s[1], s[2], a[0], a[1], s[5], s[6]), distPontoReta(s[3], s[4], a[0], a[1], s[5], s[6])) <= tol;
      S.push({ c: reta ? null : [s[1], s[2], s[3], s[4]] });
      P.push([s[5], s[6]]);
    } else { S.push({ c: null }); P.push([s[1], s[2]]); }
  }
  // junta retas colineares (não mexe no ponto inicial)
  const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  for (let i = S.length - 1; i >= 1; i--) {
    if (S[i].c || S[i - 1].c) continue;
    const a1 = ang(P[i - 1], P[i]), a2 = ang(P[i], P[i + 1]);
    let d = Math.abs(a1 - a2); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < (2 * Math.PI) / 180) { S.splice(i, 1); P.splice(i, 1); }
  }
  // quase horizontal/vertical → exata (move os dois pontos e os controles vizinhos junto)
  const fechado = Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-6;
  const mover = (idx, dx, dy) => {
    const lista = [idx];
    if (fechado && idx === 0) lista.push(P.length - 1);
    if (fechado && idx === P.length - 1) lista.push(0);
    for (const j of lista) {
      P[j][0] += dx; P[j][1] += dy;
      if (j >= 1 && S[j - 1].c) { S[j - 1].c[2] += dx; S[j - 1].c[3] += dy; }
      if (j < S.length && S[j].c) { S[j].c[0] += dx; S[j].c[1] += dy; }
    }
  };
  for (let i = 0; i < S.length; i++) {
    if (S[i].c) continue;
    const a = P[i], b = P[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < tol * 4) continue;
    const t = Math.abs(Math.atan2(dy, dx));
    if (t < ANG_RETO || Math.PI - t < ANG_RETO) { const m = (a[1] + b[1]) / 2; mover(i, 0, m - a[1]); mover(i + 1, 0, m - P[i + 1][1]); }
    else if (Math.abs(t - Math.PI / 2) < ANG_RETO) { const m = (a[0] + b[0]) / 2; mover(i, m - a[0], 0); mover(i + 1, m - P[i + 1][0], 0); }
  }
  const segs = S.map((sg, i) => (sg.c ? ['C', sg.c[0], sg.c[1], sg.c[2], sg.c[3], P[i + 1][0], P[i + 1][1]] : ['L', P[i + 1][0], P[i + 1][1]]));
  return { x0: P[0][0], y0: P[0][1], segs };
}

function pontoNaForma(px, py, polis) {
  let dentro = false;
  for (const pts of polis) {
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
  }
  return dentro;
}

// Um ponto de dentro da forma (fora dos furos): serve de "âncora" para achar a forma de novo depois.
export function pontoInterno(subs) {
  const polis = subs.map((sp) => amostrarSubpath(sp, 2));
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of polis[0]) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
  for (const fr of [0.5, 0.42, 0.58, 0.33, 0.67, 0.25, 0.75, 0.15, 0.85]) {
    const y = y0 + (y1 - y0) * fr;
    const xs = [];
    for (const pts of polis)
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    xs.sort((a, b) => a - b);
    let melhor = null, larg = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > larg) { larg = xs[i + 1] - xs[i]; melhor = [(xs[i] + xs[i + 1]) / 2, y]; }
    if (melhor) return melhor;
  }
  return [polis[0][0][0], polis[0][0][1]];
}

// Resumo das formas (para a IA escolher onde mexer e para a lista na tela). ids começam em 1.
export function resumirFormas(camadas, W, H, coresClasse = null) {
  const out = [];
  let id = 0;
  const areaImg = W * H;
  camadas.forEach((c, li) => {
    c.formas.forEach((f) => {
      id++;
      const pts = amostrarSubpath(f[0], 2);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      const e = ajusteElipse(pts);
      const ci = circuloRobusto(pts), el = elipseRobusta(pts), re = retanguloRobusto(pts);
      out.push({
        id, camada: li, classe: c.classe ?? -1, cor: f.cor || c.cor,
        caixa: [x0 / W, y0 / H, x1 / W, y1 / H].map((v) => Math.round(v * 1000) / 10),
        area: Math.round((e.A / areaImg) * 10000) / 100,
        furos: f.length - 1,
        parece: [
          ci && ci.erro < 0.03 && ci.dentro >= 0.75 ? 'circulo' : (() => { const an = ajustarAnel(f); return an && an.tipo === 'anel' ? 'pedaco-de-anel' : null; })(),
          el.erro < 0.03 && el.dentro >= 0.75 && !(ci && ci.erro < 0.03 && ci.dentro >= 0.75) ? 'elipse' : null,
          re.erro < 0.03 && re.dentro >= 0.75 ? (re.r > 0 ? 'retangulo-arredondado' : 'retangulo') : null,
        ].filter(Boolean),
      });
    });
  });
  return out;
}

// Aplica ajustes de forma (com âncoras: cor da camada + ponto interno). Devolve novas camadas.
// op = { acao: 'circulo'|'elipse'|'retangulo'|'endireitar'|'apagar'|'recolorir', ancoras:[{rgb,x,y}], cor?:'#hex', tol?: px }
export function aplicarOpsForma(camadas, ops, rgbCamada) {
  const novas = camadas.map((c) => ({ ...c, formas: c.formas.slice() }));
  const polisCache = new Map();
  const polis = (f) => { if (!polisCache.has(f)) polisCache.set(f, f.map((sp) => amostrarSubpath(sp, 2))); return polisCache.get(f); };
  const achar = (anc) => {
    const ordem = novas.map((c, li) => ({ li, d: (() => { const k = rgbCamada(c); return k ? (k[0] - anc.rgb[0]) ** 2 + (k[1] - anc.rgb[1]) ** 2 + (k[2] - anc.rgb[2]) ** 2 : Infinity; })() }))
      .filter((o) => o.d < 70 * 70).sort((a, b) => a.d - b.d);
    for (const { li } of ordem) {
      let melhor = -1, menor = Infinity;
      novas[li].formas.forEach((f, fi) => {
        if (!f) return;
        const ps = polis(f);
        if (!pontoNaForma(anc.x, anc.y, ps)) return;
        const a = Math.abs(momentos(ps[0]).A);
        if (a < menor) { menor = a; melhor = fi; }
      });
      if (melhor >= 0) return [li, melhor];
    }
    return null;
  };
  const aplicados = [];
  for (const op of ops) {
    let ok = 0;
    if (op.acao === 'circulo') {
      // junta os alvos por camada; vários pedaços (ou um arco) viram um anel/disco inteiro
      const grupos = new Map();
      for (const anc of op.ancoras || []) {
        const alvo = achar(anc);
        if (!alvo) continue;
        const [li, fi] = alvo;
        if (!grupos.has(li)) grupos.set(li, new Set());
        grupos.get(li).add(fi);
      }
      const resto = [];
      for (const [li, set] of grupos) {
        const idx = [...set];
        const formas = idx.map((fi) => novas[li].formas[fi]);
        const unico = idx.length === 1 ? (() => { const r = circuloRobusto(amostrarSubpath(formas[0][0], 1.5)); return r && r.erro < 0.03 && r.dentro >= 0.75; })() : false;
        if (unico) { resto.push(...idx.map((fi) => [li, fi])); continue; }
        const anel = ajustarAnel(formas.flat());
        if (!anel) { resto.push(...idx.map((fi) => [li, fi])); continue; }
        const nova = anel.tipo === 'anel'
          ? [subpathElipse(anel.cx, anel.cy, anel.rFora, anel.rFora), subpathElipse(anel.cx, anel.cy, anel.rDentro, anel.rDentro)]
          : [subpathElipse(anel.cx, anel.cy, anel.r, anel.r)];
        nova.cor = formas[0].cor;
        novas[li].formas[idx[0]] = nova;
        for (const fi of idx.slice(1)) novas[li].formas[fi] = null;
        // outros pedaços da mesma cor que ficaram dentro do anel novo também somem (já estão cobertos)
        const rf = anel.tipo === 'anel' ? anel.rFora : anel.r, rd = anel.tipo === 'anel' ? anel.rDentro : 0, tolA = rf * 0.02;
        novas[li].formas.forEach((f, fi) => {
          if (!f || f === nova) return;
          const pts = amostrarSubpath(f[0], 3);
          if (pts.every(([x, y]) => { const dd = Math.hypot(x - anel.cx, y - anel.cy); return dd <= rf + tolA && dd >= rd - tolA; })) novas[li].formas[fi] = null;
        });
        ok += idx.length;
      }
      // alvos que já eram círculos inteiros: ajuste normal por contorno
      if (resto.length) {
        for (const [li, fi] of resto) {
          const f = novas[li].formas[fi];
          if (!f) continue;
          const fits = f.map((sp) => { const r = circuloRobusto(amostrarSubpath(sp, 1.5)); return r && r.erro < 0.03 && r.dentro >= 0.75 ? r : null; });
          const base = fits.find(Boolean);
          if (!base) continue;
          for (const e of fits) if (e && e !== base && Math.hypot(e.cx - base.cx, e.cy - base.cy) < 0.04 * base.a) { e.cx = base.cx; e.cy = base.cy; }
          const nova = f.map((sp, k) => (fits[k] ? subpathElipse(fits[k].cx, fits[k].cy, fits[k].a, fits[k].a) : sp));
          nova.cor = f.cor;
          novas[li].formas[fi] = nova;
          polisCache.delete(f);
          ok++;
        }
      }
      aplicados.push(ok);
      continue;
    }
    for (const anc of op.ancoras || []) {
      const alvo = achar(anc);
      if (!alvo) continue;
      const [li, fi] = alvo;
      const f = novas[li].formas[fi];
      let nova = null;
      if (op.acao === 'apagar') { novas[li].formas[fi] = null; ok++; continue; }
      if (op.acao === 'recolorir') { nova = f.slice(); nova.cor = op.cor; }
      else if (op.acao === 'endireitar') { nova = f.map((sp) => endireitarSubpath(sp, op.tol || 1)); nova.cor = f.cor; }
      else if (op.acao === 'circulo' || op.acao === 'elipse' || op.acao === 'retangulo') {
        // ajusta cada contorno (externo e furos) só se ele de fato parece a forma pedida
        const fits = f.map((sp) => {
          const pts = amostrarSubpath(sp, 1.5);
          const r = op.acao === 'circulo' ? circuloRobusto(pts) : op.acao === 'elipse' ? elipseRobusta(pts) : retanguloRobusto(pts);
          return r && r.erro < 0.03 && r.dentro >= 0.75 ? r : null;
        });
        const base = fits.find(Boolean);
        if (base) {
          const tam = op.acao === 'retangulo' ? Math.max(base.w, base.h) : Math.max(base.a, base.b);
          for (const e of fits) if (e && e !== base && Math.hypot(e.cx - base.cx, e.cy - base.cy) < 0.04 * tam) { e.cx = base.cx; e.cy = base.cy; e.th = base.th; }
          nova = f.map((sp, k) => {
            const e = fits[k];
            if (!e) return sp;
            return op.acao === 'retangulo' ? subpathRetangulo(e.cx, e.cy, e.w, e.h, e.th, e.r) : subpathElipse(e.cx, e.cy, e.a, e.b, e.th);
          });
          nova.cor = f.cor;
        }
      }
      if (nova) { novas[li].formas[fi] = nova; polisCache.delete(f); ok++; }
    }
    aplicados.push(ok);
  }
  for (const c of novas) c.formas = c.formas.filter(Boolean);
  return { camadas: novas, aplicados };
}

export function ancoraDaForma(camadas, id, rgbCamada) {
  let n = 0;
  for (const c of camadas) {
    for (const f of c.formas) {
      n++;
      if (n === id) { const [x, y] = pontoInterno(f); return { rgb: rgbCamada(c), x, y }; }
    }
  }
  return null;
}
