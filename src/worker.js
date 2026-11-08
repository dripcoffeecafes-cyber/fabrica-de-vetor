// Web Worker do Vetorizador: roda o motor fora da tela principal (a interface não trava).
import * as M from './motor.js';
import { iniciarVTracer, vectorize_rgba } from './gen/vtracer_glue.js';

const WASM_B64 = '__WASM_B64__';
let vtPromessa = null;
let vt = null;

function base64ParaBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function garantirVT() {
  if (!vtPromessa) {
    vtPromessa = iniciarVTracer(base64ParaBytes(WASM_B64))
      .then(() => { vt = { vectorizeRgba: (r, w, h, o) => vectorize_rgba(r, w, h, o) }; return true; })
      .catch((e) => { console.warn('VTracer indisponível:', e); vt = null; return false; });
  }
  return vtPromessa;
}

const imagens = new Map(); // id -> { img, cache, camadas, dims }
let ultimoId = null;

function liberarCachesPesados(exceto) {
  for (const [id, e] of imagens) {
    if (id === exceto) continue;
    for (const k of Object.keys(e.cache)) if (k !== 'limpa') delete e.cache[k];
  }
}

const responder = (msg, transfer) => self.postMessage(msg, transfer || []);

// cor "de origem" de cada camada (para reencontrar formas depois de refazer o traçado)
function rgbCamada(e) {
  return (c) => (c.classe >= 0 && e.paleta && e.paleta[c.classe] ? e.paleta[c.classe].rgb : M.deHex(c.cor));
}
// aplica os ajustes de forma guardados e monta SVG de exportação + SVG da tela (com ids)
function montarResposta(e, tempo) {
  const ops = e.ops || [];
  let camadas = e.base;
  let aplicados = [];
  if (ops.length) {
    const tol = Math.max(0.6, Math.max(e.dims[0], e.dims[1]) / 900);
    const r = M.aplicarOpsForma(e.base, ops.map((o) => ({ ...o, tol: o.tol || tol })), rgbCamada(e));
    camadas = r.camadas;
    aplicados = r.aplicados;
  }
  e.camadas = camadas;
  const svg = M.montarSVG(camadas, e.dims[0], e.dims[1], e.nome);
  const svgTela = M.montarSVG(camadas, e.dims[0], e.dims[1], '', true);
  const st = M.estatisticas(camadas);
  return {
    svg, svgTela,
    stats: { ...st, kb: svg.length / 1024, tempo: tempo || e.tempo || 0 },
    info: e.info,
    ops: ops.map((o, i) => ({ acao: o.acao, rotulo: o.rotulo, origem: o.origem, achou: aplicados[i] || 0 })),
  };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  const req = m.req;
  const progresso = (etapa, pct) => responder({ tipo: 'progresso', req, etapa, pct });
  try {
    switch (m.tipo) {
      case 'iniciar': {
        const ok = await garantirVT();
        responder({ tipo: 'ok', req, vtracer: ok });
        break;
      }
      case 'carregar': {
        const img = { rgba: new Uint8ClampedArray(m.buffer), w: m.w, h: m.h };
        imagens.set(m.id, { img, cache: {} });
        responder({ tipo: 'ok', req, info: M.infoImagem(img) });
        break;
      }
      case 'descartar': {
        imagens.delete(m.id);
        responder({ tipo: 'ok', req });
        break;
      }
      case 'paleta': {
        const e = imagens.get(m.id);
        if (!e) throw new Error('Imagem não encontrada.');
        const op = m.opcoes || {};
        let base = e.img;
        if (op.limparRuido !== false) base = e.cache.limpa || (e.cache.limpa = M.suavizarRuido(e.img));
        const paleta = M.estimarPaleta(base, op.cores || 0, { maxAuto: op.maxAuto || 12 });
        responder({ tipo: 'ok', req, paleta });
        break;
      }
      case 'vetorizar': {
        const e = imagens.get(m.id);
        if (!e) throw new Error('Imagem não encontrada.');
        if (ultimoId !== m.id) { liberarCachesPesados(m.id); ultimoId = m.id; }
        const op = m.opcoes || {};
        if (op.motor === 'vtracer' || op.modo === 'foto') await garantirVT();
        const t0 = Date.now();
        const r = M.vetorizar(e.img, op, m.paleta || [], vt, e.cache, progresso);
        e.base = r.camadas;
        e.paleta = m.paleta || [];
        e.dims = [r.w, r.h];
        e.nome = m.nome || '';
        e.info = { classeFundo: r.info.classeFundo, motor: r.info.motor, trabalho: r.info.trabalho, limiar: r.info.limiar };
        e.tempo = Date.now() - t0;
        progresso('Montando o SVG', 0.97);
        responder({ tipo: 'ok', req, ...montarResposta(e, Date.now() - t0) });
        break;
      }
      case 'opForma': {
        const e = imagens.get(m.id);
        if (!e || !e.camadas) throw new Error('Vetorize a imagem antes.');
        const ancoras = Array.isArray(m.ancoras) && m.ancoras.length ? m.ancoras
          : (m.formas || []).map((fid) => M.ancoraDaForma(e.camadas, Number(fid), rgbCamada(e))).filter(Boolean);
        if (!ancoras.length) throw new Error('Não achei essa forma. Clique de novo sobre ela.');
        e.ops = e.ops || [];
        e.ops.push({ acao: m.acao, ancoras, cor: m.cor, tol: m.tol, rotulo: m.rotulo || m.acao, origem: m.origem || 'manual' });
        responder({ tipo: 'ok', req, ...montarResposta(e, 0) });
        break;
      }
      case 'desfazerOp': {
        const e = imagens.get(m.id);
        if (!e) throw new Error('Imagem não encontrada.');
        if (m.indice === 'todas') e.ops = [];
        else if (e.ops) e.ops.splice(Number(m.indice), 1);
        responder({ tipo: 'ok', req, ...montarResposta(e, 0) });
        break;
      }
      case 'ancoras': {
        const e = imagens.get(m.id);
        if (!e || !e.camadas) throw new Error('Vetorize a imagem antes.');
        const ancoras = (m.formas || []).map((fid) => M.ancoraDaForma(e.camadas, Number(fid), rgbCamada(e))).filter(Boolean);
        responder({ tipo: 'ok', req, ancoras });
        break;
      }
      case 'resumo': {
        const e = imagens.get(m.id);
        if (!e || !e.camadas) throw new Error('Vetorize a imagem antes.');
        const formas = M.resumirFormas(e.camadas, e.dims[0], e.dims[1]);
        responder({ tipo: 'ok', req, formas });
        break;
      }
      case 'pdf': {
        const e = imagens.get(m.id);
        if (!e || !e.camadas) throw new Error('Vetorize a imagem antes de baixar o PDF.');
        const bytes = M.montarPDF(e.camadas, e.dims[0], e.dims[1]);
        responder({ tipo: 'ok', req, pdf: bytes.buffer }, [bytes.buffer]);
        break;
      }
      default:
        throw new Error('Comando desconhecido: ' + m.tipo);
    }
  } catch (err) {
    responder({ tipo: 'erro', req, msg: (err && err.message) || String(err) });
  }
};
