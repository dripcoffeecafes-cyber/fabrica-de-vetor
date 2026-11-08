#!/usr/bin/env node
// Vetorizador na linha de comando (o mesmo motor da página). Sem IA, sem custo.
//
// Uso:
//   node cli.mjs <imagem|pasta> [mais imagens...] [opções]
//
// Opções:
//   --saida <pasta>        onde salvar (padrão: ao lado da imagem)
//   --tipo <logo|traco|ilustracao|foto>   (padrão: logo)
//   --cores <0|2..16>      0 = automático (padrão)
//   --fundo <auto|externo|cor|manter>
//   --suavidade <0.6..1.3> --detalhe <0..30> --qualidade <rapida|normal|alta>
//   --camadas <empilhadas|recortadas>  --motor <potrace|vtracer>
//   --cor-traco <#hex>     (tipo traco)   --limiar <auto|adaptativo|0..255>
//   --pdf                  também gera o PDF vetorial
//   --json                 imprime um resumo em JSON (para automações)
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as M from './src/motor.js';
import { iniciarVTracer, vectorize_rgba } from './src/gen/vtracer_glue.js';

const PRESETS = {
  logo: { modo: 'cores', cores: 0, maxAuto: 12, fundo: 'auto', suavidade: 1, detalhe: 2, motor: 'potrace', camadas: 'empilhadas', simplificacao: 0.35, limparRuido: true },
  traco: { modo: 'pb', limiar: 'auto', inverter: false, corTraco: '#000000', suavidade: 1, detalhe: 3, motor: 'potrace', camadas: 'empilhadas', simplificacao: 0.35, limparRuido: true },
  ilustracao: { modo: 'cores', cores: 0, maxAuto: 16, fundo: 'manter', suavidade: 1, detalhe: 2, motor: 'potrace', camadas: 'empilhadas', simplificacao: 0.35, limparRuido: true },
  foto: { modo: 'foto', fotoCores: 24, detalhe: 2, suavidade: 1, simplificacao: 0.35, limparRuido: false, fundo: 'manter', motor: 'vtracer', camadas: 'empilhadas' },
};
const EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;

function lerArgs(argv) {
  const arqs = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { arqs.push(a); continue; }
    const k = a.slice(2);
    if (k === 'pdf' || k === 'json') { o[k] = true; continue; }
    o[k] = argv[++i];
  }
  return { arqs, o };
}

const { arqs, o } = lerArgs(process.argv.slice(2));
if (!arqs.length) {
  console.log('Uso: node cli.mjs <imagem|pasta> [--tipo logo|traco|ilustracao|foto] [--cores N] [--fundo auto|externo|cor|manter] [--pdf] [--saida pasta]');
  process.exit(1);
}
const tipo = PRESETS[o.tipo] ? o.tipo : 'logo';
const op = { ...PRESETS[tipo], qualidade: o.qualidade || 'normal' };
const num = (v) => (v === undefined ? undefined : Number(v));
if (o.cores !== undefined) op.cores = num(o.cores);
if (o.fundo) op.fundo = o.fundo;
if (o.suavidade) op.suavidade = num(o.suavidade);
if (o.detalhe) op.detalhe = num(o.detalhe);
if (o.camadas) op.camadas = o.camadas;
if (o.motor) op.motor = o.motor;
if (o['cor-traco']) op.corTraco = o['cor-traco'];
if (o.limiar) op.limiar = /^\d+$/.test(o.limiar) ? Number(o.limiar) : o.limiar;

const lista = [];
for (const a of arqs) {
  if (fs.existsSync(a) && fs.statSync(a).isDirectory()) {
    for (const n of fs.readdirSync(a)) if (EXT.test(n)) lista.push(path.join(a, n));
  } else lista.push(a);
}

await iniciarVTracer(fs.readFileSync(new URL('./src/gen/vtracer.wasm', import.meta.url)));
const vt = { vectorizeRgba: (r, w, h, x) => vectorize_rgba(r, w, h, x) };
const resumo = [];

for (const arq of lista) {
  try {
    let im = sharp(arq).ensureAlpha();
    const meta = await sharp(arq).metadata();
    const lado = Math.max(meta.width || 0, meta.height || 0);
    if (lado > 3000) im = im.resize({ width: meta.width >= meta.height ? 3000 : undefined, height: meta.height > meta.width ? 3000 : undefined });
    const { data, info } = await im.raw().toBuffer({ resolveWithObject: true });
    const img = { rgba: new Uint8ClampedArray(data), w: info.width, h: info.height };
    let paleta = [];
    if (op.modo === 'cores') {
      const base = op.limparRuido ? M.suavizarRuido(img) : img;
      paleta = M.estimarPaleta(base, op.cores || 0, { maxAuto: op.maxAuto }).map((p) => ({ ...p, saida: M.paraHex(p.rgb) }));
    }
    const r = M.vetorizar(img, op, paleta, vt, {});
    const nome = path.basename(arq).replace(/\.[^.]+$/, '');
    const pasta = o.saida || path.dirname(arq);
    fs.mkdirSync(pasta, { recursive: true });
    const svg = M.montarSVG(r.camadas, r.w, r.h, path.basename(arq));
    const destino = path.join(pasta, nome + '-vetor.svg');
    fs.writeFileSync(destino, svg);
    if (o.pdf) fs.writeFileSync(path.join(pasta, nome + '-vetor.pdf'), M.montarPDF(r.camadas, r.w, r.h));
    const st = M.estatisticas(r.camadas);
    resumo.push({ arquivo: arq, svg: destino, cores: paleta.map((p) => p.saida), ...st, tempoMs: r.info.tempo });
    if (!o.json) console.log(`${path.basename(arq)} → ${destino}  (${st.cores} cores, ${st.formas} formas, ${st.nos} nós, ${r.info.tempo} ms)`);
  } catch (e) {
    resumo.push({ arquivo: arq, erro: e.message });
    if (!o.json) console.error(`${arq}: ${e.message}`);
  }
}
if (o.json) console.log(JSON.stringify(resumo, null, 2));
