# Fábrica de Vetor

Transforma logo e arte de cliente (PNG, JPG, WebP) em vetor pronto para o Illustrator, sem IA e sem custo por imagem. Tudo roda no navegador: a imagem não sai do computador.

- **Usar agora:** https://dripcoffeecafes-cyber.github.io/fabrica-de-vetor/
- **Versão com "Revisar com IA" (abre dentro do Claude):** https://claude.ai/artifact/CRUcfR57FjZTp2zSYWfHmt

> Não coloque arte de cliente neste repositório. Ele é público.

## O que faz

- Detecta as cores chapadas, tira o fundo e o miolo das letras e separa uma camada por cor.
- Exporta SVG (abre editável no Illustrator, um grupo por cor, `cor-N_HEX`), PDF vetorial e ZIP com várias imagens.
- Ajuste fino por clique: círculo, elipse ou retângulo perfeitos (o círculo também fecha um anel cortado por outra forma), endireitar retas, trocar a cor e apagar sujeira.
- Tipos de arte: Logo, Traço P&B (assinatura, carimbo, desenho escaneado), Ilustração e Foto/pôster.
- Camadas empilhadas sem frestas e sem cópias escondidas, ou recortadas para plotter e serigrafia.

## Linha de comando

O mesmo motor roda no terminal. Serve para automações e para o Claude vetorizar sem gastar token.

```sh
npm install
node cli.mjs logo-do-cliente.jpg --pdf
node cli.mjs pasta-com-imagens/ --saida vetores/
node cli.mjs assinatura.jpg --tipo traco --cor-traco "#3B2314"
```

Opções: `--tipo logo|traco|ilustracao|foto`, `--cores 0|2..16` (0 = automático), `--fundo auto|externo|cor|manter`, `--suavidade 0.6..1.3`, `--detalhe 0..30`, `--qualidade rapida|normal|alta`, `--camadas empilhadas|recortadas`, `--motor potrace|vtracer`, `--cor-traco #hex`, `--limiar auto|adaptativo|0..255`, `--pdf`, `--json`.

## Como funciona

1. Limpa o ruído do JPG sem borrar as bordas.
2. Detecta as cores chapadas da arte.
3. Amplia a imagem para traçar com precisão de subpixel.
4. Separa as cores "desmisturando" o antisserrilhado da borda: sem contorno de uma terceira cor e sem texto mudando de cor.
5. Limpa franjas e manchas e tira o fundo.
6. Traça com Potrace (curvas limpas) ou VTracer.

## Mexer no código

- `src/motor.js`: o motor (cores, limpeza, traçado, ajustes de forma, SVG/PDF).
- `src/app.js`, `src/app.css`, `src/index.html`: a interface.
- `src/worker.js`: roda o motor fora da tela.
- `npm run build` gera o `index.html` (página única, que é o que o GitHub Pages publica).

## Créditos

- Potrace, de Peter Selinger, pela porta em JavaScript [@cadit-app/potrace-ts](https://www.npmjs.com/package/@cadit-app/potrace-ts) (licença MIT declarada no pacote), adaptada em `src/potrace/`.
- [VTracer](https://github.com/visioncortex/vtracer), da visioncortex, pelo WebAssembly oficial `@visioncortex/vtracer` (MIT ou Apache-2.0).
