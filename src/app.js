/* Vetorizador — interface (roda tudo no navegador, sem IA) */
(() => {
  'use strict';
  const CODIGO_WORKER = __CODIGO_WORKER__;

  /* ---------------- utilidades ---------------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const paraHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  const normHex = (s) => {
    let t = String(s || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/i.test(t) ? '#' + t.toUpperCase() : null;
  };
  const num = (n, casas = 0) => n.toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: casas });
  const nomeBase = (n) => (n || 'imagem').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, '-') || 'imagem';
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------------- motor (Web Worker) ---------------- */
  let worker = null;
  let seq = 0;
  const pendentes = new Map();
  function iniciarWorker() {
    const url = URL.createObjectURL(new Blob([CODIGO_WORKER], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (ev) => {
      const m = ev.data;
      const p = pendentes.get(m.req);
      if (!p) return;
      if (m.tipo === 'progresso') { if (p.prog) p.prog(m.etapa, m.pct); return; }
      pendentes.delete(m.req);
      if (m.tipo === 'erro') p.rej(new Error(m.msg)); else p.res(m);
    };
    worker.onerror = (e) => { mostrarFalhaMotor(e && e.message ? e.message : 'erro ao carregar'); };
  }
  function pedir(msg, transfer, prog) {
    return new Promise((res, rej) => {
      const req = ++seq;
      pendentes.set(req, { res, rej, prog });
      worker.postMessage({ ...msg, req }, transfer || []);
    });
  }

  /* ---------------- estado ---------------- */
  const PRESETS = {
    logo: { modo: 'cores', cores: 0, maxAuto: 12, fundo: 'auto', suavidade: 1, detalhe: 2, motor: 'potrace', camadas: 'empilhadas', simplificacao: 0.35, limparRuido: true },
    traco: { modo: 'pb', limiar: 'auto', valorLimiar: 128, inverter: false, corTraco: '#000000', suavidade: 1, detalhe: 3, motor: 'potrace', camadas: 'empilhadas', simplificacao: 0.35, limparRuido: true },
    ilustracao: { modo: 'cores', cores: 0, maxAuto: 16, fundo: 'manter', suavidade: 1, detalhe: 2, motor: 'potrace', camadas: 'empilhadas', simplificacao: 0.35, limparRuido: true },
    foto: { modo: 'foto', fotoCores: 24, detalhe: 2, suavidade: 1, simplificacao: 0.35, limparRuido: false, fundo: 'manter', motor: 'vtracer', camadas: 'empilhadas' },
  };
  const DICAS = {
    logo: 'Cores chapadas. Tira o fundo e separa uma camada por cor.',
    traco: 'Desenho, assinatura ou carimbo em uma cor só.',
    ilustracao: 'Arte com mais cores. Mantém o fundo.',
    foto: 'Efeito pôster com muitas cores. O arquivo fica mais pesado.',
  };
  const est = {
    arquivos: [],
    atual: null,
    preset: 'logo',
    op: { ...PRESETS.logo, qualidade: 'normal' },
    vista: 'vetor',
    zoom: { s: 1, tx: 0, ty: 0, ajustar: true },
    comparar: 0.5,
    vtracer: null,
    contaGotas: false,
  };
  let idSeq = 0;
  const atual = () => est.arquivos.find((a) => a.id === est.atual) || null;

  function opEfetiva() {
    const op = { ...est.op };
    if (op.modo === 'pb') op.limiar = op.limiar === 'manual' ? Number(op.valorLimiar) : op.limiar;
    if (op.modo === 'foto' && est.vtracer === false) Object.assign(op, { modo: 'cores', cores: 12, fundo: 'manter', motor: 'potrace' });
    if (op.motor === 'vtracer' && est.vtracer === false) op.motor = 'potrace';
    return op;
  }
  const precisaPaleta = (op) => op.modo === 'cores';
  const chavePaleta = (op) => JSON.stringify([op.cores, op.maxAuto, op.limparRuido !== false]);
  const chaveResultado = (a, op) => JSON.stringify([op, precisaPaleta(op) ? a.paleta : null]);

  /* ---------------- leitura de arquivos ---------------- */
  const LADO_MAX = 3000;
  async function decodificar(file) {
    const url = URL.createObjectURL(file);
    let fonte;
    try {
      fonte = await createImageBitmap(file);
    } catch (_) {
      const im = new Image();
      im.src = url;
      try { await im.decode(); } catch (e) { URL.revokeObjectURL(url); throw new Error('Não consegui abrir “' + (file.name || 'a imagem') + '”. Use PNG, JPG ou WebP' + (/hei[cf]/i.test(file.type + file.name) ? ' (foto HEIC do iPhone: exporte como JPG).' : '.')); }
      fonte = im;
    }
    let w = fonte.width || fonte.naturalWidth, h = fonte.height || fonte.naturalHeight;
    if (!w || !h) { URL.revokeObjectURL(url); throw new Error('A imagem “' + file.name + '” veio sem tamanho.'); }
    if (/svg/i.test(file.type) && Math.max(w, h) < 1500) { const k = 1500 / Math.max(w, h); w *= k; h *= k; }
    const esc = Math.max(w, h) > LADO_MAX ? LADO_MAX / Math.max(w, h) : 1;
    const W = Math.max(1, Math.round(w * esc)), H = Math.max(1, Math.round(h * esc));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fonte, 0, 0, W, H);
    if (fonte.close) fonte.close();
    const dados = ctx.getImageData(0, 0, W, H);
    return { url, canvas: cv, w: W, h: H, rgba: dados.data };
  }

  async function adicionarArquivos(lista) {
    if (!worker) { mostrarFalhaMotor(); return; }
    const files = Array.from(lista || []).filter((f) => f && (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|avif|svg|heic|heif)$/i.test(f.name || '') || !f.type));
    if (!files.length) { avisar('Esse arquivo não é imagem. Use PNG, JPG ou WebP.', true); return; }
    let primeiraNova = null;
    for (const f of files) {
      try {
        const d = await decodificar(f);
        const a = { id: ++idSeq, nome: f.name || 'imagem colada.png', w: d.w, h: d.h, url: d.url, canvas: d.canvas, paleta: null, paletaChave: '', resultado: null, resultadoChave: '', status: 'novo', erro: '' };
        const buf = d.rgba.buffer.slice(0);
        await pedir({ tipo: 'carregar', id: a.id, buffer: buf, w: d.w, h: d.h }, [buf]);
        est.arquivos.push(a);
        if (/svg/i.test(f.type)) avisar('“' + f.name + '” já é SVG. Confira no Illustrator se ele já não é vetor antes de usar o resultado.');
        if (!primeiraNova) { primeiraNova = a.id; selecionar(a.id); } else desenharLista();
      } catch (e) {
        avisar(e.message, true);
      }
    }
    desenharLista();
  }

  /* ---------------- processamento ---------------- */
  let ocupado = false, deNovo = false;
  function agendar() { deNovo = true; if (!ocupado) rodar(); }
  async function rodar() {
    ocupado = true;
    while (deNovo) {
      deNovo = false;
      const a = atual();
      if (!a) break;
      try {
        await processar(a, true);
      } catch (e) {
        a.status = 'erro'; a.erro = e.message;
        avisar(e.message, true);
        mostrarProgresso(false);
        desenharLista();
      }
    }
    ocupado = false;
  }

  async function garantirPaleta(a, op, mostrar) {
    if (!precisaPaleta(op)) return;
    const ch = chavePaleta(op);
    if (a.paleta && a.paletaChave === ch) return;
    if (mostrar) progresso('Detectando cores', 0.05);
    const r = await pedir({ tipo: 'paleta', id: a.id, opcoes: op });
    a.paleta = r.paleta.map((p) => ({ rgb: p.rgb, saida: paraHex(p.rgb), peso: p.peso, transparente: false, manual: false }));
    a.paletaChave = ch;
    if (mostrar && a.id === est.atual) desenharPaleta();
  }

  async function processar(a, mostrar) {
    const op = opEfetiva();
    await garantirPaleta(a, op, mostrar);
    const ch = chaveResultado(a, op);
    if (a.resultado && a.resultadoChave === ch) { if (mostrar) mostrarResultado(a); return; }
    a.status = 'processando';
    desenharLista();
    if (mostrar) mostrarProgresso(true);
    const paleta = precisaPaleta(op) ? a.paleta.map((p) => ({ rgb: p.rgb, saida: p.saida, transparente: p.transparente, fundirEm: Number.isInteger(p.fundirEm) ? p.fundirEm : -1 })) : [];
    const r = await pedir({ tipo: 'vetorizar', id: a.id, nome: a.nome, opcoes: op, paleta }, null, mostrar ? (e, p) => progresso(e, p) : null);
    guardarResultado(a, r);
    a.resultadoChave = ch;
    a.status = 'pronto'; a.erro = '';
    desenharLista();
    if (mostrar && a.id === est.atual) { mostrarResultado(a); desenharPaleta(); }
  }

  /* ---------------- visor ---------------- */
  const visor = $('#visor');
  const imgOriginal = $('#img-original');
  const svgVetor = $('#svg-vetor');
  const mundos = $$('.mundo');

  function aplicarZoom() {
    const z = est.zoom;
    const t = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
    mundos.forEach((m) => { m.style.transform = t; });
    visor.classList.toggle('pixelado', z.s >= 2);
    visor.style.setProperty('--traco', (1.25 / z.s).toFixed(4) + 'px');
    visor.style.setProperty('--traco2', (3 / z.s).toFixed(4) + 'px');
    fecharMenuForma();
    $('#zoom-valor').textContent = num(z.s * 100) + '%';
    posicionarRegua();
  }
  function ajustar() {
    const a = atual();
    if (!a) return;
    const r = visor.getBoundingClientRect();
    const pad = r.width < 600 ? 16 : 40;
    const s = Math.min((r.width - pad * 2) / a.w, (r.height - pad * 2) / a.h);
    est.zoom = { s: clamp(s, 0.02, 40), tx: 0, ty: 0, ajustar: true };
    est.zoom.tx = (r.width - a.w * est.zoom.s) / 2;
    est.zoom.ty = (r.height - a.h * est.zoom.s) / 2;
    aplicarZoom();
  }
  function zoomEm(fator, cx, cy) {
    const z = est.zoom;
    const ns = clamp(z.s * fator, 0.02, 40);
    z.tx = cx - (cx - z.tx) * (ns / z.s);
    z.ty = cy - (cy - z.ty) * (ns / z.s);
    z.s = ns; z.ajustar = false;
    aplicarZoom();
  }
  function zoomCentro(fator) { const r = visor.getBoundingClientRect(); zoomEm(fator, r.width / 2, r.height / 2); }
  function zoom100() {
    const a = atual(); if (!a) return;
    const r = visor.getBoundingClientRect();
    const z = est.zoom;
    const cx = r.width / 2, cy = r.height / 2;
    const ix = (cx - z.tx) / z.s, iy = (cy - z.ty) / z.s;
    est.zoom = { s: 1, tx: cx - ix, ty: cy - iy, ajustar: false };
    aplicarZoom();
  }

  function definirVista(v) {
    est.vista = v;
    visor.dataset.vista = v;
    $$('#vistas button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vista === v)));
    posicionarRegua();
  }
  function posicionarRegua() {
    const r = visor.getBoundingClientRect();
    const x = Math.round(est.comparar * r.width);
    $('#camada-vetor').style.clipPath = est.vista === 'comparar' ? `inset(0 0 0 ${x}px)` : '';
    $('#regua').style.left = x + 'px';
    $('#regua').setAttribute('aria-valuenow', String(Math.round(est.comparar * 100)));
  }

  // arrastar / zoom com roda / pinça
  const ponteiros = new Map();
  let arrasto = null, moveu = false, pinca = null;
  visor.addEventListener('pointerdown', (e) => {
    if (!atual() || e.target.closest('#regua, .vazio .seletor, #menu-forma')) return;
    visor.setPointerCapture(e.pointerId);
    ponteiros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moveu = false;
    if (ponteiros.size === 1) arrasto = { x: e.clientX, y: e.clientY, tx: est.zoom.tx, ty: est.zoom.ty };
    else if (ponteiros.size === 2) {
      const [p1, p2] = [...ponteiros.values()];
      pinca = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), s: est.zoom.s };
      arrasto = null;
    }
  });
  visor.addEventListener('pointermove', (e) => {
    if (!ponteiros.has(e.pointerId)) return;
    ponteiros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinca && ponteiros.size === 2) {
      const [p1, p2] = [...ponteiros.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const r = visor.getBoundingClientRect();
      zoomEm((pinca.s * d) / pinca.d / est.zoom.s, (p1.x + p2.x) / 2 - r.left, (p1.y + p2.y) / 2 - r.top);
      moveu = true;
      return;
    }
    if (!arrasto) return;
    const dx = e.clientX - arrasto.x, dy = e.clientY - arrasto.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moveu = true;
    if (!moveu) return;
    est.zoom.tx = arrasto.tx + dx; est.zoom.ty = arrasto.ty + dy; est.zoom.ajustar = false;
    aplicarZoom();
    visor.classList.add('arrastando');
  });
  const soltar = (e) => {
    if (!ponteiros.has(e.pointerId)) return;
    ponteiros.delete(e.pointerId);
    if (ponteiros.size < 2) pinca = null;
    visor.classList.remove('arrastando');
    if (!moveu && e.type === 'pointerup') {
      if (est.contaGotas) pegarCor(e);
      else if (!e.target.closest('#menu-forma')) cliqueNaForma(e);
    }
    if (ponteiros.size === 0) arrasto = null;
  };
  visor.addEventListener('pointerup', soltar);
  visor.addEventListener('pointercancel', soltar);
  visor.addEventListener('wheel', (e) => {
    if (!atual()) return;
    e.preventDefault();
    const r = visor.getBoundingClientRect();
    zoomEm(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  window.addEventListener('resize', debounce(() => { if (est.zoom.ajustar) ajustar(); else posicionarRegua(); }, 120));

  // régua do comparar
  (() => {
    const regua = $('#regua');
    let ativo = false;
    regua.addEventListener('pointerdown', (e) => { ativo = true; regua.setPointerCapture(e.pointerId); e.stopPropagation(); });
    regua.addEventListener('pointermove', (e) => {
      if (!ativo) return;
      const r = visor.getBoundingClientRect();
      est.comparar = clamp((e.clientX - r.left) / r.width, 0, 1);
      posicionarRegua();
    });
    const fim = () => { ativo = false; };
    regua.addEventListener('pointerup', fim);
    regua.addEventListener('pointercancel', fim);
    regua.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        est.comparar = clamp(est.comparar + (e.key === 'ArrowLeft' ? -0.05 : 0.05), 0, 1);
        posicionarRegua();
        e.preventDefault();
      }
    });
  })();

  function mostrarResultado(a) {
    if (!a.resultado) return;
    const limpo = (a.resultado.svgTela || a.resultado.svg).replace(/<\?xml[^>]*\?>/, '').replace(/<!-{2}[\s\S]*?-{2}>/g, '');
    svgVetor.innerHTML = limpo;
    const el = svgVetor.querySelector('svg');
    if (el) { el.setAttribute('width', a.w); el.setAttribute('height', a.h); el.setAttribute('preserveAspectRatio', 'none'); }
    mostrarProgresso(false);
    const s = a.resultado.stats;
    $('#st-cores').textContent = num(s.cores);
    $('#st-formas').textContent = num(s.formas);
    $('#st-nos').textContent = num(s.nos);
    $('#st-kb').textContent = s.kb >= 1024 ? num(s.kb / 1024, 1) + ' MB' : num(s.kb) + ' KB';
    $('#st-tempo').textContent = num(s.tempo / 1000, 1) + ' s';
    $('#estatisticas').hidden = false;
    habilitarExportar(true);
    desenharOps(a);
  }

  function prepararVisor(a) {
    $('#vazio').hidden = !!a;
    visor.classList.toggle('com-imagem', !!a);
    mundos.forEach((m) => { m.style.width = (a ? a.w : 0) + 'px'; m.style.height = (a ? a.h : 0) + 'px'; });
    if (!a) { imgOriginal.removeAttribute('src'); svgVetor.innerHTML = ''; $('#estatisticas').hidden = true; habilitarExportar(false); return; }
    imgOriginal.src = a.url;
    svgVetor.innerHTML = '';
    habilitarExportar(false);
    ajustar();
  }

  let barraTimer = null;
  function mostrarProgresso(sim) {
    const b = $('#progresso');
    clearTimeout(barraTimer);
    if (sim) { b.hidden = false; visor.setAttribute('aria-busy', 'true'); }
    else { barraTimer = setTimeout(() => { b.hidden = true; }, 150); visor.removeAttribute('aria-busy'); }
  }
  function progresso(etapa, pct) {
    mostrarProgresso(true);
    $('#progresso-texto').textContent = etapa + '…';
    $('#progresso i').style.width = Math.round(clamp(pct, 0.03, 1) * 100) + '%';
  }

  /* ---------------- lista de arquivos ---------------- */
  const ROTULO_STATUS = { novo: 'Na fila', processando: 'Vetorizando…', pronto: 'Pronto', erro: 'Erro' };
  function desenharLista() {
    const ul = $('#lista');
    ul.innerHTML = '';
    for (const a of est.arquivos) {
      const li = document.createElement('li');
      li.className = 'arquivo' + (a.id === est.atual ? ' ativo' : '') + ' status-' + a.status;
      li.innerHTML = `<button class="arquivo-abrir" type="button"><img alt="" src="${a.url}"><span class="arquivo-nome"></span><span class="arquivo-status"></span></button><button class="arquivo-remover" type="button" aria-label="Tirar da lista">×</button>`;
      $('.arquivo-nome', li).textContent = a.nome;
      $('.arquivo-status', li).textContent = a.status === 'erro' ? a.erro || ROTULO_STATUS.erro : `${a.w}×${a.h} px, ${ROTULO_STATUS[a.status].toLowerCase()}`;
      $('.arquivo-abrir', li).addEventListener('click', () => selecionar(a.id));
      $('.arquivo-remover', li).addEventListener('click', () => remover(a.id));
      ul.appendChild(li);
    }
    $('#bloco-arquivos').classList.toggle('tem-arquivos', est.arquivos.length > 0);
    $('#btn-zip').hidden = est.arquivos.length < 2;
  }
  function selecionar(id) {
    est.atual = id;
    const a = atual();
    fecharMenuForma();
    desenharLista();
    desenharRevisao(a);
    prepararVisor(a);
    desenharPaleta();
    if (a) { if (a.resultado) mostrarResultado(a); agendar(); }
  }
  function remover(id) {
    const i = est.arquivos.findIndex((a) => a.id === id);
    if (i < 0) return;
    const [a] = est.arquivos.splice(i, 1);
    URL.revokeObjectURL(a.url);
    pedir({ tipo: 'descartar', id }).catch(() => {});
    if (est.atual === id) {
      const prox = est.arquivos[i] || est.arquivos[i - 1] || null;
      est.atual = null;
      if (prox) selecionar(prox.id); else { prepararVisor(null); desenharPaleta(); }
    }
    desenharLista();
  }

  /* ---------------- paleta (placas de cor) ---------------- */
  function desenharPaleta() {
    const a = atual();
    const box = $('#placas');
    box.innerHTML = '';
    const op = opEfetiva();
    $('#bloco-cores').hidden = op.modo !== 'cores';
    if (!a || !a.paleta || op.modo !== 'cores') {
      $('#placas-vazio').hidden = op.modo !== 'cores' || !!(a && a.paleta);
      return;
    }
    $('#placas-vazio').hidden = true;
    const fundo = a.resultado && a.resultado.info ? a.resultado.info.classeFundo : -1;
    a.paleta.forEach((p, i) => {
      const d = document.createElement('div');
      const junta = Number.isInteger(p.fundirEm) && p.fundirEm >= 0 && p.fundirEm !== i;
      d.className = 'placa' + (p.transparente ? ' transparente' : '') + (junta ? ' fundida' : '') + (i === fundo && est.op.fundo !== 'manter' ? ' fundo' : '');
      d.innerHTML = `
        <label class="placa-cor" style="--c:${p.saida}">
          <input type="color" value="${p.saida.toLowerCase()}" aria-label="Trocar a cor ${i + 1}">
          <span class="placa-tag">${i === fundo && est.op.fundo !== 'manter' ? 'fundo' : p.manual ? 'incluída' : ''}</span>
        </label>
        <div class="placa-linha">
          <input class="placa-hex" value="${p.saida}" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Código da cor ${i + 1}">
          <span class="placa-pct" title="Quanto da imagem tem essa cor">${p.manual ? '' : num(p.peso * 100, p.peso < 0.01 ? 1 : 0) + '%'}</span>
        </div>
        ${junta ? `<div class="placa-junta">junto com a cor ${p.fundirEm + 1} <button type="button" class="botao-texto placa-separar">Separar</button></div>` : ''}
        <div class="placa-acoes">
          <button type="button" class="placa-transp" aria-pressed="${p.transparente}" title="${p.transparente ? 'Voltar a imprimir esta cor' : 'Deixar esta cor transparente'}">${p.transparente ? 'Mostrar' : 'Ocultar'}</button>
          <button type="button" class="placa-remover" title="Tirar esta cor (os pixels vão para a cor mais parecida)" aria-label="Tirar a cor ${i + 1}">×</button>
        </div>`;
      const cor = $('input[type=color]', d);
      const hexIn = $('.placa-hex', d);
      cor.addEventListener('input', () => {
        const h = cor.value.toUpperCase();
        $('.placa-cor', d).style.setProperty('--c', h);
        hexIn.value = h;
        recolorirAoVivo(i, h);
      });
      cor.addEventListener('change', () => { p.saida = cor.value.toUpperCase(); agendar(); });
      const aplicarHex = () => {
        const h = normHex(hexIn.value);
        if (!h) { hexIn.value = p.saida; avisar('Use um código de cor como #3B2314.', true); return; }
        hexIn.value = h;
        if (h !== p.saida) { p.saida = h; $('.placa-cor', d).style.setProperty('--c', h); cor.value = h.toLowerCase(); agendar(); }
      };
      hexIn.addEventListener('change', aplicarHex);
      hexIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { hexIn.blur(); } });
      $('.placa-transp', d).addEventListener('click', () => { p.transparente = !p.transparente; desenharPaleta(); agendar(); });
      const sep = $('.placa-separar', d);
      if (sep) sep.addEventListener('click', () => { p.fundirEm = -1; desenharPaleta(); agendar(); });
      $('.placa-remover', d).addEventListener('click', () => {
        if (a.paleta.length <= 1) { avisar('A arte precisa de pelo menos uma cor.', true); return; }
        a.paleta.splice(i, 1);
        for (const q of a.paleta) if (Number.isInteger(q.fundirEm)) q.fundirEm = q.fundirEm === i ? -1 : q.fundirEm > i ? q.fundirEm - 1 : q.fundirEm;
        desenharPaleta();
        agendar();
      });
      box.appendChild(d);
    });
    $('#n-cores').textContent = a.paleta.filter((p) => !p.transparente).length + (a.paleta.length === 1 ? ' cor' : ' cores');
  }

  function recolorirAoVivo(i, h) {
    const a = atual();
    if (!a || !a.paleta) return;
    const antiga = a.paleta[i].saida.replace('#', '');
    $$('g[id$="_' + antiga + '"]', svgVetor).forEach((g) => g.setAttribute('fill', h));
  }

  function pegarCor(e) {
    const a = atual();
    if (!a) return;
    const r = visor.getBoundingClientRect();
    const ix = Math.floor((e.clientX - r.left - est.zoom.tx) / est.zoom.s);
    const iy = Math.floor((e.clientY - r.top - est.zoom.ty) / est.zoom.s);
    if (ix < 0 || iy < 0 || ix >= a.w || iy >= a.h) return;
    const ctx = a.canvas.getContext('2d', { willReadFrequently: true });
    const x0 = clamp(ix - 1, 0, a.w - 3), y0 = clamp(iy - 1, 0, a.h - 3);
    const d = ctx.getImageData(x0, y0, Math.min(3, a.w), Math.min(3, a.h)).data;
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k + 3] > 127) { rr += d[k]; gg += d[k + 1]; bb += d[k + 2]; n++; }
    alternarContaGotas(false);
    if (!n) { avisar('Esse ponto é transparente. Clique numa parte colorida.', true); return; }
    const rgb = [rr / n, gg / n, bb / n].map(Math.round);
    if (!a.paleta) a.paleta = [];
    a.paleta.push({ rgb, saida: paraHex(rgb), peso: 0, transparente: false, manual: true });
    desenharPaleta();
    agendar();
    avisar('Cor ' + paraHex(rgb) + ' incluída.');
  }
  function alternarContaGotas(sim) {
    est.contaGotas = sim;
    visor.classList.toggle('conta-gotas', sim);
    $('#btn-conta-gotas').setAttribute('aria-pressed', String(sim));
    if (sim) {
      if (est.vista === 'contornos') definirVista('original');
      avisar('Clique na imagem, na cor que faltou.');
    }
  }

  /* ---------------- controles ---------------- */
  function sincronizarControles() {
    const op = est.op;
    $$('#tipos button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === est.preset)));
    $('#dica-tipo').textContent = DICAS[est.preset];
    $('#ctl-cores').value = String(op.cores || 0);
    $('#ctl-fundo').value = op.fundo || 'auto';
    $('#ctl-suavidade').value = op.suavidade;
    $('#ctl-detalhe').value = op.detalhe;
    $('#ctl-qualidade').value = op.qualidade;
    $('#ctl-motor').value = op.motor || 'potrace';
    $('#ctl-camadas').value = op.camadas || 'empilhadas';
    $('#ctl-simplificacao').value = op.simplificacao;
    $('#ctl-ruido').checked = op.limparRuido !== false;
    $('#ctl-limiar').value = op.limiar || 'auto';
    $('#ctl-valor-limiar').value = op.valorLimiar || 128;
    $('#ctl-cor-traco').value = (op.corTraco || '#000000').toLowerCase();
    $('#ctl-inverter').checked = !!op.inverter;
    $('#ctl-foto-cores').value = op.fotoCores || 24;
    const modo = opEfetiva().modo;
    $('#bloco-cores').hidden = modo !== 'cores';
    $('#bloco-pb').hidden = modo !== 'pb';
    $('#bloco-foto').hidden = est.preset !== 'foto' || modo !== 'foto';
    $('#bloco-fundo').hidden = modo !== 'cores';
    $('#linha-valor-limiar').hidden = op.limiar !== 'manual';
    $('#ctl-motor').disabled = est.vtracer === false;
    atualizarSaidas();
  }
  function atualizarSaidas() {
    $('#out-suavidade').textContent = num(Number(est.op.suavidade), 2);
    $('#out-detalhe').textContent = num(Number(est.op.detalhe));
    $('#out-simplificacao').textContent = num(Number(est.op.simplificacao), 2);
    $('#out-valor-limiar').textContent = String(est.op.valorLimiar || 128);
    $('#out-foto-cores').textContent = String(est.op.fotoCores || 24);
  }
  const agendarDevagar = debounce(agendar, 280);
  function ligar(id, chave, conv = (v) => v, imediato = false) {
    const el = $(id);
    const ev = el.type === 'range' ? 'input' : 'change';
    el.addEventListener(ev, () => {
      est.op[chave] = el.type === 'checkbox' ? el.checked : conv(el.value);
      atualizarSaidas();
      if (chave === 'limiar') $('#linha-valor-limiar').hidden = el.value !== 'manual';
      if (chave === 'fundo' || chave === 'cores') desenharPaleta();
      if (imediato) agendar(); else agendarDevagar();
    });
  }
  ligar('#ctl-cores', 'cores', Number, true);
  ligar('#ctl-fundo', 'fundo', String, true);
  ligar('#ctl-suavidade', 'suavidade', Number);
  ligar('#ctl-detalhe', 'detalhe', Number);
  ligar('#ctl-qualidade', 'qualidade', String, true);
  ligar('#ctl-motor', 'motor', String, true);
  ligar('#ctl-camadas', 'camadas', String, true);
  ligar('#ctl-simplificacao', 'simplificacao', Number);
  ligar('#ctl-ruido', 'limparRuido', Boolean, true);
  ligar('#ctl-limiar', 'limiar', String, true);
  ligar('#ctl-valor-limiar', 'valorLimiar', Number);
  ligar('#ctl-cor-traco', 'corTraco', (v) => v.toUpperCase(), true);
  ligar('#ctl-inverter', 'inverter', Boolean, true);
  ligar('#ctl-foto-cores', 'fotoCores', Number);

  $$('#tipos button').forEach((b) => b.addEventListener('click', () => {
    est.preset = b.dataset.preset;
    est.op = { ...PRESETS[est.preset], qualidade: est.op.qualidade };
    sincronizarControles();
    desenharPaleta();
    agendar();
  }));
  $('#btn-redetectar').addEventListener('click', () => { const a = atual(); if (!a) return; a.paleta = null; a.paletaChave = ''; agendar(); });
  $('#btn-conta-gotas').addEventListener('click', () => alternarContaGotas(!est.contaGotas));

  $$('#vistas button').forEach((b) => b.addEventListener('click', () => definirVista(b.dataset.vista)));
  $$('#fundos-visor button').forEach((b) => b.addEventListener('click', () => {
    visor.dataset.fundo = b.dataset.fundo;
    $$('#fundos-visor button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#zoom-mais').addEventListener('click', () => zoomCentro(1.4));
  $('#zoom-menos').addEventListener('click', () => zoomCentro(1 / 1.4));
  $('#zoom-ajustar').addEventListener('click', ajustar);
  $('#zoom-valor').addEventListener('click', zoom100);

  /* ---------------- entrada de arquivos ---------------- */
  $$('.entrada-arquivo').forEach((inp) => inp.addEventListener('change', () => {
    const lista = Array.from(inp.files || []);
    inp.value = '';
    if (lista.length) adicionarArquivos(lista);
  }));
  const alvoSoltar = document.body;
  let contSoltar = 0;
  alvoSoltar.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { contSoltar++; document.body.classList.add('soltando'); e.preventDefault(); } });
  alvoSoltar.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  alvoSoltar.addEventListener('dragleave', () => { contSoltar = Math.max(0, contSoltar - 1); if (!contSoltar) document.body.classList.remove('soltando'); });
  alvoSoltar.addEventListener('drop', (e) => {
    e.preventDefault();
    contSoltar = 0;
    document.body.classList.remove('soltando');
    if (e.dataTransfer && e.dataTransfer.files.length) adicionarArquivos(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const itens = [...((e.clipboardData && e.clipboardData.items) || [])].filter((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (!itens.length) return;
    e.preventDefault();
    adicionarArquivos(itens.map((i) => i.getAsFile()).filter(Boolean));
  });

  /* ---------------- exportar ---------------- */
  let nsDownloads;
  function prepararDownloads() {
    try {
      if (window.claude && typeof window.claude.use === 'function') {
        nsDownloads = window.claude.use('downloads').then((ns) => ns || null).catch(() => null);
      } else nsDownloads = Promise.resolve(undefined);
    } catch (_) { nsDownloads = Promise.resolve(undefined); }
  }
  async function salvar(nome, dados, mime) {
    let ns = await nsDownloads;
    if (ns === undefined && window.claude && typeof window.claude.use === 'function') {
      ns = await window.claude.use('downloads').catch(() => null);
    }
    if (ns) {
      try {
        await ns.save({ filename: nome, data: dados });
        avisar('Arquivo salvo: ' + nome);
      } catch (e) {
        const c = e && e.code;
        if (c === 'declined') avisar('Download cancelado.');
        else if (c === 'rate_limited') avisar('Espere um instante e tente de novo.', true);
        else avisar('Não deu para baixar aqui (' + (c || 'indisponível') + '). Use “Copiar SVG”.', true);
      }
      return;
    }
    if (ns === null) { avisar('Este visualizador não permite downloads. Use “Copiar SVG” ou abra a página no navegador do computador.', true); return; }
    const blob = dados instanceof Blob ? dados : new Blob([dados], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = nome;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    avisar('Arquivo baixado: ' + nome);
  }
  function habilitarExportar(sim) {
    ['#btn-svg', '#btn-pdf', '#btn-copiar'].forEach((s) => { $(s).disabled = !sim; });
  }
  $('#btn-svg').addEventListener('click', () => {
    const a = atual(); if (!a || !a.resultado) return;
    salvar(nomeBase(a.nome) + '-vetor.svg', a.resultado.svg, 'image/svg+xml');
  });
  $('#btn-pdf').addEventListener('click', async () => {
    const a = atual(); if (!a || !a.resultado) return;
    try {
      await processar(a, false);
      const r = await pedir({ tipo: 'pdf', id: a.id });
      salvar(nomeBase(a.nome) + '-vetor.pdf', new Uint8Array(r.pdf), 'application/pdf');
    } catch (e) { avisar(e.message, true); }
  });
  $('#btn-copiar').addEventListener('click', async () => {
    const a = atual(); if (!a || !a.resultado) return;
    try {
      await navigator.clipboard.writeText(a.resultado.svg);
      avisar('SVG copiado. No Illustrator, Ctrl+V cola como vetor.');
    } catch (_) {
      abrirCopiaManual(a.resultado.svg);
    }
  });
  function abrirCopiaManual(txt) {
    const dlg = $('#copia-manual');
    const ta = $('textarea', dlg);
    ta.value = txt;
    dlg.hidden = false;
    ta.focus(); ta.select();
  }
  $('#copia-fechar').addEventListener('click', () => { $('#copia-manual').hidden = true; });

  $('#btn-zip').addEventListener('click', async () => {
    if (est.arquivos.length < 2) return;
    const btn = $('#btn-zip');
    btn.disabled = true;
    const arquivosZip = [];
    const enc = new TextEncoder();
    const usados = new Set();
    try {
      for (let i = 0; i < est.arquivos.length; i++) {
        const a = est.arquivos[i];
        btn.textContent = `Vetorizando ${i + 1} de ${est.arquivos.length}…`;
        await processar(a, a.id === est.atual);
        let base = nomeBase(a.nome), n = 2;
        while (usados.has(base)) base = nomeBase(a.nome) + '-' + n++;
        usados.add(base);
        arquivosZip.push({ nome: base + '-vetor.svg', dados: enc.encode(a.resultado.svg) });
        const r = await pedir({ tipo: 'pdf', id: a.id });
        arquivosZip.push({ nome: base + '-vetor.pdf', dados: new Uint8Array(r.pdf) });
      }
      const hoje = new Date();
      const carimbo = hoje.getFullYear() + String(hoje.getMonth() + 1).padStart(2, '0') + String(hoje.getDate()).padStart(2, '0');
      await salvar('vetores-' + carimbo + '.zip', zipar(arquivosZip), 'application/zip');
    } catch (e) {
      avisar(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Baixar todas (.zip)';
      const a = atual(); if (a) { mostrarResultado(a); desenharPaleta(); }
    }
  });

  // ZIP simples (sem compressão), com nomes em UTF-8
  const TABELA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = TABELA_CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zipar(lista) {
    const enc = new TextEncoder();
    const partes = [], central = [];
    let off = 0;
    const d = new Date();
    const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of lista) {
      const nome = enc.encode(f.nome);
      const crc = crc32(f.dados);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, hora, true); lh.setUint16(12, data, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, f.dados.length, true); lh.setUint32(22, f.dados.length, true); lh.setUint16(26, nome.length, true); lh.setUint16(28, 0, true);
      partes.push(new Uint8Array(lh.buffer), nome, f.dados);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, hora, true); ch.setUint16(14, data, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, f.dados.length, true); ch.setUint32(24, f.dados.length, true); ch.setUint16(28, nome.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nome);
      off += 30 + nome.length + f.dados.length;
    }
    const tamCentral = central.reduce((s, p) => s + p.length, 0);
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, lista.length, true); fim.setUint16(10, lista.length, true);
    fim.setUint32(12, tamCentral, true); fim.setUint32(16, off, true);
    return new Blob([...partes, ...central, new Uint8Array(fim.buffer)], { type: 'application/zip' });
  }

  /* ---------------- avisos e ajuda ---------------- */
  let avisoTimer = null;
  function avisar(txt, erro = false) {
    const t = $('#aviso');
    t.textContent = txt;
    t.classList.toggle('erro', !!erro);
    t.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => { t.hidden = true; }, erro ? 6000 : 3200);
  }
  const ajuda = $('#ajuda');
  $$('[data-ajuda]').forEach((b) => b.addEventListener('click', () => { ajuda.hidden = false; $('#ajuda-fechar').focus(); }));
  $('#ajuda-fechar').addEventListener('click', () => { ajuda.hidden = true; });
  ajuda.addEventListener('click', (e) => { if (e.target === ajuda) ajuda.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { ajuda.hidden = true; $('#copia-manual').hidden = true; fecharMenuForma(); if (est.contaGotas) alternarContaGotas(false); }
  });

  /* ---------------- ajuste fino: formas (sem IA) ---------------- */
  const ROTULO_ACAO = { circulo: 'Círculo perfeito', elipse: 'Elipse perfeita', retangulo: 'Retângulo perfeito', endireitar: 'Retas endireitadas', apagar: 'Forma apagada', recolorir: 'Cor trocada' };
  function guardarResultado(a, r) {
    a.resultado = { svg: r.svg, svgTela: r.svgTela, stats: r.stats, info: r.info, ops: r.ops || [] };
  }
  let formaSel = null;
  function fecharMenuForma() {
    const m = $('#menu-forma');
    if (m) m.hidden = true;
    $$('#svg-vetor path.selecionada').forEach((p) => p.classList.remove('selecionada'));
    formaSel = null;
  }
  function cliqueNaForma(e) {
    const a = atual();
    if (!a || !a.resultado || est.vista === 'original') { fecharMenuForma(); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const path = el && el.closest ? el.closest('#svg-vetor path[data-f]') : null;
    if (!path) { fecharMenuForma(); return; }
    fecharMenuForma();
    formaSel = Number(path.dataset.f);
    path.classList.add('selecionada');
    const m = $('#menu-forma');
    $('#menu-forma-titulo').textContent = 'Forma ' + formaSel;
    $('#menu-cores').hidden = true;
    m.hidden = false;
    const r = visor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = e.clientX - r.left + 12, y = e.clientY - r.top + 12;
    if (x + mw > r.width - 8) x = Math.max(8, e.clientX - r.left - mw - 12);
    if (y + mh > r.height - 8) y = Math.max(8, r.height - mh - 8);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    const primeiro = $('button[data-acao]', m);
    if (primeiro) primeiro.focus({ preventScroll: true });
  }
  async function aplicarOpForma(a, acao, ids, extra = {}) {
    const r = await pedir({ tipo: 'opForma', id: a.id, acao, formas: ids, ancoras: extra.ancoras, cor: extra.cor, rotulo: extra.rotulo || ROTULO_ACAO[acao], origem: extra.origem || 'manual' });
    guardarResultado(a, r);
    if (a.id === est.atual) mostrarResultado(a);
    const ultimo = r.ops && r.ops[r.ops.length - 1];
    if (ultimo && !ultimo.achou) avisar('Essa forma não parece um(a) ' + (ROTULO_ACAO[acao] || acao).toLowerCase().replace(' perfeito', '').replace(' perfeita', '') + '. Nada mudou; desfaça na lista se quiser.', true);
    return r;
  }
  $$('#menu-forma button[data-acao]').forEach((b) => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const a = atual();
    if (!a || !formaSel) return;
    const acao = b.dataset.acao;
    if (acao === 'recolorir') {
      const box = $('#menu-cores');
      box.innerHTML = '';
      const cores = a.paleta && opEfetiva().modo === 'cores' ? [...new Set(a.paleta.filter((p) => !p.transparente).map((p) => p.saida))] : [];
      if (!cores.includes('#000000')) cores.push('#000000');
      if (!cores.includes('#FFFFFF')) cores.push('#FFFFFF');
      for (const c of cores) {
        const bt = document.createElement('button');
        bt.type = 'button'; bt.style.setProperty('--c', c); bt.title = c; bt.setAttribute('aria-label', 'Cor ' + c);
        bt.addEventListener('click', async (e2) => {
          e2.stopPropagation();
          const id = formaSel; fecharMenuForma();
          try { await aplicarOpForma(a, 'recolorir', [id], { cor: c, rotulo: 'Cor trocada para ' + c }); } catch (err) { avisar(err.message, true); }
        });
        box.appendChild(bt);
      }
      box.hidden = false;
      return;
    }
    const id = formaSel;
    fecharMenuForma();
    try { await aplicarOpForma(a, acao, [id]); } catch (err) { avisar(err.message, true); }
  }));
  $('#menu-fechar').addEventListener('click', (e) => { e.stopPropagation(); fecharMenuForma(); });

  function desenharOps(a) {
    const area = $('#ops-area');
    const lista = $('#ops-lista');
    const ops = (a && a.resultado && a.resultado.ops) || [];
    area.hidden = !ops.length;
    lista.innerHTML = '';
    ops.forEach((o, i) => {
      const li = document.createElement('li');
      if (!o.achou) li.className = 'perdido';
      li.innerHTML = `<span><span class="txt"></span><span class="origem"></span></span><button type="button" aria-label="Desfazer">×</button>`;
      $('.txt', li).textContent = o.rotulo + (o.achou > 1 ? ` (${o.achou} formas)` : '');
      $('.origem', li).textContent = o.origem === 'ia' ? 'IA' : '';
      $('button', li).addEventListener('click', async () => {
        try { const r = await pedir({ tipo: 'desfazerOp', id: a.id, indice: i }); guardarResultado(a, r); mostrarResultado(a); } catch (err) { avisar(err.message, true); }
      });
      lista.appendChild(li);
    });
  }
  $('#btn-ops-limpar').addEventListener('click', async () => {
    const a = atual(); if (!a) return;
    try { const r = await pedir({ tipo: 'desfazerOp', id: a.id, indice: 'todas' }); guardarResultado(a, r); mostrarResultado(a); } catch (err) { avisar(err.message, true); }
  });

  /* ---------------- ajuste fino: revisão com IA (só no clique) ---------------- */
  let nsSample = Promise.resolve(null);
  let iaControle = null;
  let iaUsos = 0;
  function prepararSample() {
    try {
      if (window.claude && typeof window.claude.use === 'function') nsSample = window.claude.use('sample').then((ns) => ns || null).catch(() => null);
    } catch (_) { nsSample = Promise.resolve(null); }
    nsSample.then(async (ns) => {
      let ok = !!ns;
      if (ns && ns.limits) {
        const lim = await ns.limits().catch(() => null);
        ok = !!(lim && lim.images && lim.images.maxCount >= 2);
      }
      $('#ia-area').hidden = !ok;
      $('#ia-indisponivel').hidden = ok;
    });
  }

  async function blobDaImagem(desenhar, w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#D4D4D4';
    ctx.fillRect(0, 0, w, h);
    await desenhar(ctx);
    return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Não consegui preparar a imagem.'))), 'image/png'));
  }
  async function imagensParaIA(a) {
    const k = Math.min(1, 1024 / Math.max(a.w, a.h));
    const w = Math.max(1, Math.round(a.w * k)), h = Math.max(1, Math.round(a.h * k));
    const original = await blobDaImagem((ctx) => { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(a.canvas, 0, 0, w, h); }, w, h);
    const url = URL.createObjectURL(new Blob([a.resultado.svg], { type: 'image/svg+xml' }));
    try {
      const im = new Image();
      im.src = url;
      await im.decode();
      const vetor = await blobDaImagem((ctx) => ctx.drawImage(im, 0, 0, w, h), w, h);
      return [original, vetor];
    } finally { URL.revokeObjectURL(url); }
  }

  function montarPrompt(a, formas, pedido) {
    const op = opEfetiva();
    const fundo = a.resultado.info ? a.resultado.info.classeFundo : -1;
    let cores;
    if (op.modo === 'cores' && a.paleta) {
      cores = a.paleta.map((p, i) => `cor ${i + 1}: ${p.saida}, ${num(p.peso * 100, 1)}% da imagem` +
        (p.transparente ? ', oculta' : '') + (Number.isInteger(p.fundirEm) && p.fundirEm >= 0 && p.fundirEm !== i ? `, juntada com a cor ${p.fundirEm + 1}` : '') +
        (i === fundo && op.fundo !== 'manter' ? ', é a cor do fundo (removida conforme a opção de fundo)' : '')).join('\n');
    } else if (op.modo === 'pb') cores = `traço de uma cor só: ${op.corTraco}`;
    else cores = 'modo pôster (muitas cores)';
    const lista = formas.filter((f) => f.area >= 0.02).sort((x, y) => y.area - x.area).slice(0, 70).sort((x, y) => x.id - y.id);
    const linhas = lista.map((f) => `#${f.id} ${f.classe >= 0 && op.modo === 'cores' ? 'cor ' + (f.classe + 1) : f.cor}, caixa [${f.caixa.join(', ')}], área ${f.area}%` +
      (f.furos ? `, ${f.furos} furo(s)` : '') + (f.parece.length ? `, parece ${f.parece.join('/')}` : '')).join('\n');
    const resto = formas.length - lista.length;
    return `Você revisa a vetorização automática de uma arte de cliente (logo, ilustração ou texto) que vai ser impressa em embalagem de café. O motor já fez o traçado; você só aponta AJUSTES PONTUAIS que o motor sabe executar.

Imagem 1: arte original (pixels). Imagem 2: vetor gerado, no mesmo enquadramento. Nas duas, cinza liso (#D4D4D4) = transparente.

Configuração atual: tipo=${est.preset}, quantidade de cores=${op.cores || 'automático'}, fundo=${op.fundo || '-'}, suavidade=${op.suavidade}, limpeza de manchas=${op.detalhe}, qualidade=${op.qualidade}.
Cores do vetor:
${cores}
Formas (id, cor, caixa em % da largura/altura [x0, y0, x1, y1], área em % da imagem; "parece" = forma geométrica que o motor consegue deixar perfeita):
${linhas}${resto > 0 ? `\n(+${resto} formas pequenas não listadas)` : ''}
${pedido ? `\nPedido do designer: "${pedido.replace(/"/g, "'")}"\n` : ''}
Compare as imagens e proponha só o que for claramente necessário para o vetor ficar fiel à arte e limpo para impressão. Se já estiver bom, devolva "ajustes": [].
Tipos de ajuste (use só estes; ids e números de cor como acima):
- {"tipo":"parametros","valores":{...},"motivo":"..."}: problema geral. Campos possíveis: preset (logo|traco|ilustracao|foto), cores (0 = automático, ou de 2 a 16), fundo (auto|externo|cor|manter), suavidade (0.6 a 1.3), detalhe (0 a 30), qualidade (rapida|normal|alta).
- {"tipo":"cor","cor":N,"hex":"#RRGGBB","motivo":"..."}: corrigir o tom de uma cor (ex.: quase branco vira #FFFFFF).
- {"tipo":"juntar_cores","de":N,"para":M,"motivo":"..."}: duas cores que na arte são a mesma.
- {"tipo":"ocultar_cor","cor":N,"motivo":"..."}: cor que não deve ser impressa (sujeira, sombra).
- {"tipo":"forma","acao":"circulo|elipse|retangulo|endireitar|apagar","formas":[ids],"motivo":"..."}: deixar perfeita uma forma que deveria ser geométrica (prefira as marcadas com "parece"), endireitar retas tortas ou apagar sujeira. "circulo" também fecha um anel cortado por outra forma por cima: passe todos os pedaços dele juntos (os marcados "pedaco-de-anel" da mesma cor).
- {"tipo":"forma","acao":"recolorir","formas":[ids],"cor":N,"motivo":"..."}: pedaço que ficou com a cor errada.
As camadas são empilhadas: uma cor de baixo preenche por baixo o que ela envolve (ex.: o anel de fora vira um disco inteiro sob as cores de dentro) e passa um pouco por baixo das cores vizinhas. Por isso a mesma borda pode aparecer em mais de uma forma; ao deixar um anel ou círculo perfeito, inclua todas as formas daquela borda.

Responda SÓ com JSON neste formato:
{"diagnostico":"1 ou 2 frases em português","ajustes":[...],"dicas":["o que o motor não resolve; ex.: a fonte parece X, vale redigitar o texto"]}`;
  }

  function descreverAjuste(aj) {
    const v = aj.valores || {};
    switch (aj.tipo) {
      case 'parametros': {
        const nomes = { preset: 'tipo', cores: 'cores', fundo: 'fundo', suavidade: 'suavidade', detalhe: 'limpeza', qualidade: 'qualidade' };
        const fundoTxt = { auto: 'tirar fundo e miolos', externo: 'tirar só o fundo de fora', cor: 'tirar a cor do fundo toda', manter: 'manter fundo' };
        return 'Mudar ' + Object.keys(v).filter((k) => nomes[k]).map((k) => `${nomes[k]}: ${k === 'fundo' ? fundoTxt[v[k]] || v[k] : k === 'cores' && Number(v[k]) === 0 ? 'automático' : v[k]}`).join(', ');
      }
      case 'cor': return `Cor ${aj.cor} vira ${aj.hex}`;
      case 'juntar_cores': return `Juntar a cor ${aj.de} com a cor ${aj.para}`;
      case 'ocultar_cor': return `Ocultar a cor ${aj.cor}`;
      case 'forma': {
        const ids = (aj.formas || []).map((f) => '#' + f).join(', ');
        if (aj.acao === 'recolorir') return `Trocar para a cor ${aj.cor}: forma ${ids}`;
        return `${ROTULO_ACAO[aj.acao] || aj.acao}: forma ${ids}`;
      }
      default: return null;
    }
  }

  async function aplicarAjusteIA(a, aj) {
    const n = (v) => Number(v) - 1;
    const temCor = (i) => a.paleta && i >= 0 && i < a.paleta.length;
    switch (aj.tipo) {
      case 'parametros': {
        const v = aj.valores || {};
        if (v.preset && PRESETS[v.preset] && v.preset !== est.preset) { est.preset = v.preset; est.op = { ...PRESETS[v.preset], qualidade: est.op.qualidade }; }
        if (v.cores !== undefined) est.op.cores = clamp(Math.round(Number(v.cores) || 0), 0, 16);
        if (['auto', 'externo', 'cor', 'manter'].includes(v.fundo)) est.op.fundo = v.fundo;
        if (v.suavidade !== undefined && isFinite(v.suavidade)) est.op.suavidade = clamp(Number(v.suavidade), 0.6, 1.3);
        if (v.detalhe !== undefined && isFinite(v.detalhe)) est.op.detalhe = clamp(Math.round(Number(v.detalhe)), 0, 30);
        if (['rapida', 'normal', 'alta'].includes(v.qualidade)) est.op.qualidade = v.qualidade;
        sincronizarControles(); desenharPaleta();
        await processar(a, true);
        return true;
      }
      case 'cor': {
        const i = n(aj.cor), h = normHex(aj.hex);
        if (!temCor(i) || !h) return false;
        a.paleta[i].saida = h; desenharPaleta(); await processar(a, true); return true;
      }
      case 'juntar_cores': {
        const de = n(aj.de), para = n(aj.para);
        if (!temCor(de) || !temCor(para) || de === para) return false;
        a.paleta[de].fundirEm = para; desenharPaleta(); await processar(a, true); return true;
      }
      case 'ocultar_cor': {
        const i = n(aj.cor);
        if (!temCor(i)) return false;
        a.paleta[i].transparente = true; desenharPaleta(); await processar(a, true); return true;
      }
      case 'forma': {
        if (!ROTULO_ACAO[aj.acao] || !aj.ancoras || !aj.ancoras.length) return false;
        let cor;
        if (aj.acao === 'recolorir') { const i = n(aj.cor); cor = temCor(i) ? a.paleta[i].saida : normHex(String(aj.cor)); if (!cor) return false; }
        await aplicarOpForma(a, aj.acao, [], { ancoras: aj.ancoras, cor, origem: 'ia', rotulo: descreverAjuste(aj) });
        return true;
      }
    }
    return false;
  }

  function desenharRevisao(a) {
    const box = $('#ia-resultado');
    const rev = a && a.ia;
    box.hidden = !rev;
    if (!rev) return;
    $('#ia-diagnostico').textContent = rev.diagnostico || '';
    const ul = $('#ia-lista');
    ul.innerHTML = '';
    rev.ajustes.forEach((aj) => {
      const li = document.createElement('li');
      if (aj.feito) li.className = 'feito';
      li.innerHTML = `<span class="titulo"></span><button type="button" class="botao"></button><span class="motivo"></span>`;
      $('.titulo', li).textContent = aj.texto;
      $('.motivo', li).textContent = aj.motivo || '';
      const bt = $('button', li);
      bt.textContent = aj.feito ? 'Aplicado' : 'Aplicar';
      bt.disabled = !!aj.feito;
      bt.addEventListener('click', async () => {
        bt.disabled = true;
        try { aj.feito = await aplicarAjusteIA(a, aj); if (!aj.feito) avisar('Esse ajuste não se aplica mais a esta imagem.', true); }
        catch (err) { avisar(err.message, true); }
        desenharRevisao(a);
      });
      ul.appendChild(li);
    });
    $('#btn-ia-tudo').hidden = rev.ajustes.filter((x) => !x.feito).length < 2;
    const dicas = $('#ia-dicas');
    dicas.innerHTML = '';
    for (const d of rev.dicas || []) { const li = document.createElement('li'); li.textContent = d; dicas.appendChild(li); }
    if (!rev.ajustes.length && !(rev.dicas || []).length) $('#ia-diagnostico').textContent = (rev.diagnostico || '') + ' Nenhum ajuste necessário.';
  }

  $('#btn-ia-tudo').addEventListener('click', async () => {
    const a = atual(); if (!a || !a.ia) return;
    const btn = $('#btn-ia-tudo'); btn.disabled = true;
    // primeiro o que muda o traçado inteiro, depois as formas (que já estão ancoradas)
    const ordem = [...a.ia.ajustes].sort((x, y) => (x.tipo === 'forma') - (y.tipo === 'forma'));
    for (const aj of ordem) {
      if (aj.feito) continue;
      try { aj.feito = await aplicarAjusteIA(a, aj); } catch (err) { avisar(err.message, true); }
    }
    btn.disabled = false;
    desenharRevisao(a);
  });

  const MSG_IA = {
    not_granted: 'Você não liberou a IA para esta página. Os ajustes por clique continuam funcionando.',
    sampling_disabled: 'A IA não está disponível nesta conta.',
    rate_limited: 'Limite de uso atingido por agora. Tente de novo mais tarde.',
    session_expired: 'Sua sessão expirou. Entre de novo no Claude.',
    image_rejected: 'A imagem não pôde ser enviada para a IA.',
    images_unavailable: 'Esta visualização não envia imagens para a IA.',
    invalid_json: 'A resposta veio fora do formato. Tente de novo.',
    refused: 'A IA não quis analisar essa imagem.',
    upstream_error: 'Falha de conexão com a IA. Tente de novo.',
  };
  $('#btn-ia').addEventListener('click', async () => {
    const a = atual();
    if (!a || !a.resultado) { avisar('Vetorize uma imagem antes de revisar.', true); return; }
    const sample = await nsSample;
    if (!sample) { avisar('A revisão com IA só funciona com a página aberta pelo Claude.', true); return; }
    const btn = $('#btn-ia'), parar = $('#btn-ia-parar');
    btn.disabled = true; parar.hidden = false;
    btn.textContent = 'Preparando…';
    iaControle = new AbortController();
    try {
      const [res, imgs] = await Promise.all([pedir({ tipo: 'resumo', id: a.id }), imagensParaIA(a)]);
      const prompt = montarPrompt(a, res.formas, $('#ia-pedido').value.trim());
      btn.textContent = 'Pensando…';
      const resp = await sample.json(prompt, {
        images: imgs, modelTier: 'default', signal: iaControle.signal,
        onText: () => { btn.textContent = 'Escrevendo…'; },
      });
      iaUsos++;
      $('#ia-contador').textContent = iaUsos === 1 ? '1 revisão nesta sessão' : iaUsos + ' revisões nesta sessão';
      const ajustes = Array.isArray(resp && resp.ajustes) ? resp.ajustes : [];
      // formas citadas viram âncoras agora (continuam valendo mesmo se o traçado for refeito)
      const prontos = [];
      for (const aj of ajustes) {
        if (!aj || typeof aj !== 'object') continue;
        const texto = descreverAjuste(aj);
        if (!texto) continue;
        if (aj.tipo === 'forma') {
          const ids = (aj.formas || []).map(Number).filter((x) => x > 0);
          if (!ids.length || !ROTULO_ACAO[aj.acao]) continue;
          const anc = await pedir({ tipo: 'ancoras', id: a.id, formas: ids });
          if (!anc.ancoras.length) continue;
          prontos.push({ ...aj, ancoras: anc.ancoras, texto, motivo: aj.motivo });
        } else prontos.push({ ...aj, texto, motivo: aj.motivo });
      }
      a.ia = { diagnostico: String((resp && resp.diagnostico) || ''), ajustes: prontos, dicas: Array.isArray(resp && resp.dicas) ? resp.dicas.map(String).slice(0, 5) : [] };
      desenharRevisao(a);
    } catch (e) {
      if (e && e.code !== 'cancelled') avisar((e && MSG_IA[e.code]) || (e && e.message) || 'A revisão falhou.', true);
      if (e && (e.code === 'not_granted' || e.code === 'sampling_disabled')) { $('#ia-area').hidden = true; $('#ia-indisponivel').hidden = false; }
    } finally {
      btn.disabled = false; btn.textContent = 'Revisar com IA'; parar.hidden = true; iaControle = null;
    }
  });
  $('#btn-ia-parar').addEventListener('click', () => { if (iaControle) iaControle.abort(); });

  function mostrarFalhaMotor(detalhe) {
    const p = $('#vazio-erro');
    p.textContent = 'O motor não conseguiu iniciar aqui' + (detalhe ? ' (' + detalhe + ')' : '') + '. Abra este link no navegador do celular (Chrome ou Safari) ou no computador.';
    p.hidden = false;
    avisar(p.textContent, true);
  }
  window.addEventListener('error', (e) => { if (e && e.message) avisar('Erro: ' + e.message, true); });
  window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; if (r && r.message && !r.code) avisar('Erro: ' + r.message, true); });

  /* ---------------- início ---------------- */
  try {
    iniciarWorker();
  } catch (e) {
    worker = null;
    mostrarFalhaMotor(e && e.message);
  }
  prepararDownloads();
  prepararSample();
  sincronizarControles();
  definirVista('vetor');
  prepararVisor(null);
  if (worker) pedir({ tipo: 'iniciar' }).then((r) => {
    est.vtracer = !!r.vtracer;
    $('#motor-status').textContent = r.vtracer ? 'Potrace + VTracer prontos' : 'Potrace pronto (VTracer bloqueado neste navegador)';
    sincronizarControles();
  }).catch(() => { est.vtracer = false; sincronizarControles(); });
})();
