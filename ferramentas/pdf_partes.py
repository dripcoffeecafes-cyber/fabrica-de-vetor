#!/usr/bin/env python3
"""Separa um PDF em: o que já é vetor (SVG de cada página) e as imagens em pixel coladas dentro dele.
Uso: python3 ferramentas/pdf_partes.py arquivo.pdf [--saida pasta]
Gera: pagina-N.svg (vetor original, texto em curvas), pagina-N-600dpi.png (prévia),
      imagem-N-K.png (cada imagem embutida no tamanho real) e partes.json (onde cada imagem fica na página).
Precisa: pymupdf.
"""
import argparse, json, os
import pymupdf

ap = argparse.ArgumentParser(); ap.add_argument('pdf'); ap.add_argument('--saida', default='.')
a = ap.parse_args(); os.makedirs(a.saida, exist_ok=True)
doc = pymupdf.open(a.pdf); info = []
for p in doc:
    n = p.number + 1
    open(os.path.join(a.saida, f'pagina-{n}.svg'), 'w').write(p.get_svg_image(text_as_path=True))
    p.get_pixmap(dpi=600).save(os.path.join(a.saida, f'pagina-{n}-600dpi.png'))
    pag = {'pagina': n, 'tamanho_pt': [p.rect.width, p.rect.height], 'desenhos_vetor': len(p.get_drawings()), 'imagens': []}
    for k, im in enumerate(p.get_images(full=True), 1):
        x = doc.extract_image(im[0]); arq = f'imagem-{n}-{k}.{x["ext"]}'
        open(os.path.join(a.saida, arq), 'wb').write(x['image'])
        pag['imagens'].append({'arquivo': arq, 'px': [x['width'], x['height']], 'xref': im[0],
                               'onde_pt': [list(r) for r in p.get_image_rects(im[0])]})
    info.append(pag)
json.dump(info, open(os.path.join(a.saida, 'partes.json'), 'w'), indent=1)
print(json.dumps(info, indent=1))
