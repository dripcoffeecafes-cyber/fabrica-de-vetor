// Monta o index.html (página única: interface + motor num Web Worker + WASM do VTracer embutido).
// Uso: npm install && npm run build
import fs from 'fs';
import * as esbuild from 'esbuild';

const raiz = new URL('.', import.meta.url).pathname;
const caminho = (p) => raiz + p;

// 1) "Cola" do VTracer: converte a versão Node do @visioncortex/vtracer num módulo ES que carrega o WASM de bytes.
//    Se o pacote não estiver instalado, usa a cópia já gerada em src/gen/.
const origem = caminho('node_modules/@visioncortex/vtracer/pkg/vtracer_wasm.js');
if (fs.existsSync(origem)) {
  let s = fs.readFileSync(origem, 'utf8');
  s = s.replace(/^exports\.\w+ = \w+;\s*$/gm, '');
  const corte = s.indexOf('const wasmPath = ');
  if (corte < 0) throw new Error('formato inesperado da cola do VTracer');
  s = '// GERADO a partir de @visioncortex/vtracer (MIT OR Apache-2.0)\nlet wasm;\n' + s.slice(0, corte) + `
export async function iniciarVTracer(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, __wbg_get_imports());
  wasm = instance.exports;
  wasm.__wbindgen_start();
  return true;
}
export { vectorize_rgba, vectorize_bytes };
`;
  fs.mkdirSync(caminho('src/gen'), { recursive: true });
  fs.writeFileSync(caminho('src/gen/vtracer_glue.js'), s);
  fs.copyFileSync(caminho('node_modules/@visioncortex/vtracer/pkg/vtracer_wasm_bg.wasm'), caminho('src/gen/vtracer.wasm'));
  console.log('cola do VTracer gerada');
}

// 2) Worker (motor) com o WASM em base64
const w = await esbuild.build({
  entryPoints: [caminho('src/worker.js')], bundle: true, format: 'iife', minify: false, target: 'es2020', write: false, legalComments: 'inline',
});
let codigoWorker = w.outputFiles[0].text;
if (!codigoWorker.includes('__WASM_B64__')) throw new Error('marcador do WASM sumiu');
codigoWorker = codigoWorker.replace('__WASM_B64__', fs.readFileSync(caminho('src/gen/vtracer.wasm')).toString('base64'));

// 3) Interface + CSS dentro do HTML
const escapar = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '\\u003C!--').replace(/<script/gi, '\\u003Cscript');
let app = fs.readFileSync(caminho('src/app.js'), 'utf8');
if (!app.includes('__CODIGO_WORKER__')) throw new Error('marcador do worker sumiu');
app = app.replace('__CODIGO_WORKER__', () => escapar(JSON.stringify(codigoWorker)));
let html = fs.readFileSync(caminho('src/index.html'), 'utf8');
html = html.replace('<!--CSS-->', () => '<style>' + fs.readFileSync(caminho('src/app.css'), 'utf8') + '</style>');
html = html.replace('<!--APP-->', () => '<script>' + app + '</script>');
if (/<!--CSS-->|<!--APP-->/.test(html)) throw new Error('marcadores não substituídos');
fs.writeFileSync(caminho('index.html'), html);
console.log('index.html', (html.length / 1024).toFixed(0), 'KB');
