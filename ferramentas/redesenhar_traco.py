#!/usr/bin/env python3
"""Redesenha arte de TRAÇO (letra cursiva, linhas, ícones de linha) a partir de imagem pequena/ruim.
Em vez de contornar os pixels, acha a linha central de cada traço, suaviza curva e espessura e
redesenha limpo em alta resolução. Depois cada cor é traçada pelo motor (cli.mjs) e montada num SVG.

Uso:
  python3 ferramentas/redesenhar_traco.py arte.png --cor "#B8965A" [--cor "#502E19" ...]
         [--fundo "#FFFFFF"] [--suav 13] [--suav-larg 26] [--pontos 2.2]
         [--excluir x0,y0,x1,y1 ...]   (caixas em px da imagem original, ignoradas no redesenho)
         [--saida pasta]
Saída: <nome>-redesenhado.svg (um grupo por cor) e <nome>-redesenhado.png (prévia).
Precisa: numpy scipy scikit-image skan pillow; e `npm install` feito na raiz do repositório.
"""
import argparse, os, re, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.morphology import skeletonize
from skan import Skeleton

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
hexrgb = lambda h: np.array([int(h.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)], float)

def cobertura(img, cor, fundo):
    d = fundo - cor
    return np.clip(((fundo - img) @ d) / (d @ d), 0, 1)

def redesenhar(mask, desenho, R, suav_xy, suav_w, pontos):
    dt = ndi.distance_transform_edt(mask)
    lab, n = ndi.label(mask)
    for k in range(1, n + 1):
        comp = lab == k
        sk = skeletonize(comp)
        L = int(sk.sum())
        larg = 2 * np.median(dt[sk]) if L else 0
        if L < pontos * max(larg, 1) or comp.sum() < 400:  # pingo/ponto: elipse
            ys, xs = np.nonzero(comp)
            if len(xs) < 3: continue
            cy, cx = ys.mean(), xs.mean()
            ev, vec = np.linalg.eigh(np.cov(np.vstack([xs, ys])))
            a, b = 2 * np.sqrt(max(ev[1], 0)) + .5, 2 * np.sqrt(max(ev[0], 0)) + .5
            ang = np.arctan2(vec[1, 1], vec[0, 1])
            t = np.linspace(0, 2 * np.pi, 90)
            px = cx + a * np.cos(t) * np.cos(ang) - b * np.sin(t) * np.sin(ang)
            py = cy + a * np.cos(t) * np.sin(ang) + b * np.sin(t) * np.cos(ang)
            desenho.polygon(list(zip(px * R, py * R)), fill=0)
            continue
        g = Skeleton(sk)
        listas = g.paths_list()
        grau = {}
        for p in listas:
            for nd in (p[0], p[-1]): grau[nd] = grau.get(nd, 0) + 1
        for i, p in enumerate(listas):
            c = g.path_coordinates(i).astype(float)
            seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))]
            solto = grau[p[0]] == 1 or grau[p[-1]] == 1
            if solto and len(listas) > 1 and seg[-1] < 1.2 * larg: continue  # galho espúrio
            if seg[-1] < 2: continue
            w = 2 * dt[c[:, 0].astype(int), c[:, 1].astype(int)]
            s = np.arange(0, seg[-1], 1.0)
            cy, cx, ww = (np.interp(s, seg, v) for v in (c[:, 0], c[:, 1], w))
            if len(s) > 8:
                cy = ndi.gaussian_filter1d(cy, suav_xy, mode='nearest')
                cx = ndi.gaussian_filter1d(cx, suav_xy, mode='nearest')
                ww = ndi.gaussian_filter1d(ww, suav_w, mode='nearest')
            for y, x, r in zip(cy, cx, ww / 2):
                desenho.ellipse([(x - r) * R, (y - r) * R, (x + r) * R, (y + r) * R], fill=0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('imagem'); ap.add_argument('--cor', action='append', required=True)
    ap.add_argument('--fundo', default='#FFFFFF'); ap.add_argument('--suav', type=float, default=13)
    ap.add_argument('--suav-larg', type=float, default=26); ap.add_argument('--pontos', type=float, default=2.2)
    ap.add_argument('--excluir', action='append', default=[]); ap.add_argument('--saida', default='.')
    a = ap.parse_args()
    base = Image.open(a.imagem).convert('RGBA')
    fundo = hexrgb(a.fundo)
    bg = Image.new('RGBA', base.size, tuple(int(v) for v in fundo) + (255,)); bg.alpha_composite(base)
    W0, H0 = base.size
    S = max(4, int(np.ceil(1800 / max(W0, H0))))  # análise com ~1800 px no lado maior
    R = 2                                          # saída com o dobro disso
    up = np.asarray(bg.convert('RGB').resize((W0 * S, H0 * S), Image.LANCZOS)).astype(float)
    Yu, Xu = np.mgrid[0:H0 * S, 0:W0 * S] / S
    fora = np.zeros(Yu.shape, bool)
    for cx in a.excluir:
        x0, y0, x1, y1 = map(float, cx.split(','))
        fora |= (Xu >= x0) & (Xu <= x1) & (Yu >= y0) & (Yu <= y1)
    cores = [hexrgb(c) for c in a.cor]
    # cada pixel vai para a cor cuja mistura com o fundo explica melhor o pixel
    # (borda antisserrilhada de uma cor escura não vira uma cor clara)
    def residuo(c):
        d = c - fundo
        t = np.clip(((up - fundo) @ d) / (d @ d), 0, 1)
        return np.linalg.norm(up - (fundo + t[..., None] * d), axis=2) + 4 * (t < 0.08)
    dono = np.stack([residuo(c) for c in cores]).argmin(0)
    nome = os.path.splitext(os.path.basename(a.imagem))[0]
    os.makedirs(a.saida, exist_ok=True)
    tmp = tempfile.mkdtemp()
    grupos = []; W = H = None
    for i, (hx, c) in enumerate(zip(a.cor, cores)):
        cob = cobertura(up, c, fundo); cob[(dono != i) | fora] = 0
        mask = ndi.gaussian_filter(cob, 1.5) > 0.42
        lab, n = ndi.label(mask); tam = ndi.sum(mask, lab, range(1, n + 1))
        mask = np.isin(lab, 1 + np.nonzero(tam > 40)[0])
        img = Image.new('L', (W0 * S * R, H0 * S * R), 255)
        redesenhar(mask, ImageDraw.Draw(img), R, a.suav, a.suav_larg, a.pontos)
        p = os.path.join(tmp, f'camada{i}.png'); img.save(p)
        subprocess.run(['node', os.path.join(RAIZ, 'cli.mjs'), p, '--tipo', 'traco', '--saida', tmp], check=True, capture_output=True)
        s = open(os.path.join(tmp, f'camada{i}-vetor.svg')).read()
        W, H = map(float, re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', s).groups())
        paths = [re.sub(r'\sfill="[^"]*"', '', q) for q in re.findall(r'<path[^>]*/>', s)]
        grupos.append(f'<g id="cor-{i + 1}_{hx.lstrip("#").upper()}" fill="{hx}">\n' + '\n'.join(paths) + '\n</g>')
        print(f'{hx}: {len(paths)} formas')
    svg = os.path.join(a.saida, nome + '-redesenhado.svg')
    open(svg, 'w').write(f'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{W:g}" height="{H:g}" viewBox="0 0 {W:g} {H:g}">\n' + '\n'.join(grupos) + '\n</svg>\n')
    print(svg)

if __name__ == '__main__':
    main()
