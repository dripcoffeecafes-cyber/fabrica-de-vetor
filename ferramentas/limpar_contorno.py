"""Contorno limpo a partir do pixel: retas viram retas exatas, curvas viram uma bezier contínua."""
import numpy as np, math
from PIL import Image
from scipy import ndimage as nd
from skimage import measure

def dp(pts,tol):
    pts=np.asarray(pts)
    def rec(a,b):
        if b<=a+1: return [a]
        p,q=pts[a],pts[b]; d=q-p; n=np.hypot(*d)
        seg=pts[a+1:b]
        if n<1e-9: dist=np.hypot(*(seg-p).T)
        else: dist=np.abs(d[0]*(seg[:,1]-p[1])-d[1]*(seg[:,0]-p[0]))/n
        i=np.argmax(dist)
        if dist[i]>tol: return rec(a,a+1+i)+rec(a+1+i,b)
        return [a]
    return rec(0,len(pts)-1)+[len(pts)-1]

def _bezpt(c,u):
    u=np.asarray(u)[:,None]; p0,c1,c2,p3=c
    return (1-u)**3*p0+3*(1-u)**2*u*c1+3*(1-u)*u*u*c2+u**3*p3
def _fit(P,u,t0,t1):
    p0,p3=P[0],P[-1]
    A1=t0[None,:]*(3*(1-u)**2*u)[:,None]; A2=t1[None,:]*(3*(1-u)*u*u)[:,None]
    C=np.array([[np.sum(A1*A1),np.sum(A1*A2)],[np.sum(A1*A2),np.sum(A2*A2)]])
    tmp=P-_bezpt((p0,p0,p3,p3),u)
    X=np.array([np.sum(A1*tmp),np.sum(A2*tmp)])
    L=np.hypot(*(p3-p0))
    try: a,b=np.linalg.solve(C,X)
    except Exception: a=b=L/3
    if a<1e-3*L or b<1e-3*L or a>1.5*L or b>1.5*L: a=b=L/3
    return (p0,p0+t0*a,p3+t1*b,p3)
def _reparam(c,P,u):
    p0,c1,c2,p3=c
    d1=[3*(c1-p0),3*(c2-c1),3*(p3-c2)]; d2=[2*(d1[1]-d1[0]),2*(d1[2]-d1[1])]
    uu=u[:,None]
    Q=_bezpt(c,u); Q1=(1-uu)**2*d1[0]+2*(1-uu)*uu*d1[1]+uu**2*d1[2]; Q2=(1-uu)*d2[0]+uu*d2[1]
    num=np.sum((Q-P)*Q1,1); den=np.sum(Q1*Q1,1)+np.sum((Q-P)*Q2,1)
    nu=u-np.where(np.abs(den)>1e-9,num/den,0); return np.clip(nu,0,1)
def fit_rec(P,t0,t1,tol=0.08,depth=0):
    """t0: tangente de saída no início; t1: tangente de chegada no fim (direção do movimento)"""
    P=np.asarray(P,float)
    if len(P)<3:
        L=np.hypot(*(P[-1]-P[0]))/3; return [('C',P[0]+t0*L,P[-1]-t1*L,P[-1])]
    d=np.cumsum(np.r_[0,np.hypot(*np.diff(P,axis=0).T)]); u=d/d[-1]
    c=_fit(P,u,t0,-t1)
    for _ in range(8):
        u=_reparam(c,P,u); c=_fit(P,u,t0,-t1)
    err=np.hypot(*(_bezpt(c,u)-P).T); k=int(np.argmax(err))
    if err[k]<=tol or len(P)<6 or depth>5: return [('C',c[1],c[2],c[3])]
    k=min(max(k,2),len(P)-3)
    tm=P[k+1]-P[k-1]; tm=tm/np.hypot(*tm)
    return fit_rec(P[:k+1],t0,tm,tol,depth+1)+fit_rec(P[k:],tm,t1,tol,depth+1)

def smooth_open(P,sig):
    """suaviza pontos internos ao longo do comprimento, mantendo as pontas"""
    P=np.asarray(P,float)
    if len(P)<5 or sig<=0: return P
    d=np.cumsum(np.r_[0,np.hypot(*np.diff(P,axis=0).T)])
    out=P.copy()
    for i in range(1,len(P)-1):
        w=np.exp(-0.5*((d-d[i])/sig)**2)
        # limita a janela para não puxar as pontas
        rr=min(d[i],d[-1]-d[i]); w[np.abs(d-d[i])>rr]=0
        out[i]=(w[:,None]*P).sum(0)/w.sum()
    return out

def bez(p0,c1,c2,p3,n=20):
    u=np.linspace(0,1,n)[:,None]
    return (1-u)**3*p0+3*(1-u)**2*u*c1+3*(1-u)*u*u*c2+u**3*p3

def contour_to_path(C,tol=0.22,minline=1.6,angtol=7):
    """C: pontos (x,y) fechados em px. devolve lista de comandos ('M',p),('L',p),('C',c1,c2,p)"""
    C=np.asarray(C)[:-1]
    # começa num ponto de canto (maior curvatura) para não cortar uma reta
    idx=dp(np.vstack([C,C[:1]]),tol); V=C[np.array(idx[:-1])%len(C)]
    n=len(V)
    segs=[]
    for i in range(n):
        p,q=V[i],V[(i+1)%n]; d=q-p; L=np.hypot(*d); ang=math.degrees(math.atan2(d[1],d[0]))%180
        axis = 'h' if min(ang,180-ang)<angtol else ('v' if abs(ang-90)<angtol else None)
        straight = L>=(1.0 if axis else globals().get('DIAG',8.0))
        segs.append(dict(i=i,L=L,axis=axis,straight=straight,d=d/L if L else d))
    # índice do ponto original de cada vértice para recuperar a curva fina
    vidx=np.array(idx[:-1])%len(C)
    # retas: ajustar por mínimos quadrados nos pontos originais, e travar no eixo
    lines={}
    for s in segs:
        if not s['straight']: continue
        i=s['i']; a,b=vidx[i],vidx[(i+1)%n]
        pts=C[a:b+1] if b>a else np.vstack([C[a:],C[:b+1]])
        m=pts.mean(0)
        dev=np.max(np.abs((pts-m)@np.array([-s['d'][1],s['d'][0]]))) if len(pts)>2 else 0
        if dev>0.18: continue
        if s['axis']=='h': dirv=np.array([np.sign(s['d'][0]) or 1,0.])
        elif s['axis']=='v': dirv=np.array([0,np.sign(s['d'][1]) or 1.])
        else:
            u,sv,vt=np.linalg.svd(pts-m); dirv=vt[0]*np.sign(vt[0]@s['d'])
        lines[i]=(m,dirv)
    # alinha retas do mesmo eixo que estão quase na mesma coordenada (mesmo lado da letra)
    for ax,k in (('h',1),('v',0)):
        ids=[i for i in lines if segs[i]['axis']==ax]
        ids.sort(key=lambda i:lines[i][0][k])
        grp=[]
        for i in ids:
            if grp and abs(lines[i][0][k]-lines[grp[-1]][0][k])<0.6: grp.append(i)
            else:
                if len(grp)>1:
                    wsum=sum(segs[g]['L'] for g in grp); c=sum(lines[g][0][k]*segs[g]['L'] for g in grp)/wsum
                    for g in grp: m_,d_=lines[g]; m_=m_.copy(); m_[k]=c; lines[g]=(m_,d_)
                grp=[i]
        if len(grp)>1:
            wsum=sum(segs[g]['L'] for g in grp); c=sum(lines[g][0][k]*segs[g]['L'] for g in grp)/wsum
            for g in grp: m_,d_=lines[g]; m_=m_.copy(); m_[k]=c; lines[g]=(m_,d_)
    if not lines:  # contorno todo curvo (ex.: contra-forma pequena): uma bezier por trecho do DP com tangentes suaves
        lines={}
    def inter(l1,l2):
        (m1,d1),(m2,d2)=l1,l2; A=np.array([d1,-d2]).T
        if abs(np.linalg.det(A))<1e-6: return None
        t=np.linalg.solve(A,m2-m1); return m1+d1*t[0]
    def proj(l,p): m,d=l; return m+d*((p-m)@d)
    straight_ids=sorted(lines)
    out=[]
    if not straight_ids:
        # curva fechada: catmull-rom pelos vértices do DP
        P=V; k=len(P)
        out.append(('M',P[0]))
        for i in range(k):
            p0,p1,p2,p3=P[i-1],P[i],P[(i+1)%k],P[(i+2)%k]
            out.append(('C',p1+(p2-p0)/6,p2-(p3-p1)/6,p2))
        return out
    # para cada reta, pontos inicial e final (interseção com a próxima reta se adjacentes, senão projeção)
    ends={}
    m=len(straight_ids)
    for j,i in enumerate(straight_ids):
        nxt=straight_ids[(j+1)%m]
        if (i+1)%n==nxt:   # canto vivo entre duas retas
            p=inter(lines[i],lines[nxt]); 
            if p is None: p=V[(i+1)%n]
            ends.setdefault(i,{})['e']=p; ends.setdefault(nxt,{})['s']=p
    SHARP=globals().get('SHARP',2.0); SMOOTH=globals().get('SMOOTH',0.6); DELTA=globals().get('DELTA',1.3); nxt_start_override={}
    for j,i in enumerate(straight_ids):
        nxt=straight_ids[(j+1)%m]
        if (i+1)%n==nxt: continue
        p=inter(lines[i],lines[nxt])
        if p is None: continue
        a=proj(lines[i],V[(i+1)%n]); b=proj(lines[nxt],V[nxt])
        cosang=abs(lines[i][1]@lines[nxt][1])
        near=np.min(np.hypot(*(C-p).T))
        if cosang<0.25 and near<0.9 and np.hypot(*(a-p))<SHARP and np.hypot(*(b-p))<SHARP and (p-lines[i][0])@lines[i][1]>0:
            ends.setdefault(i,{})['e']=p; ends.setdefault(nxt,{})['s']=p; ends[i]['sharp']=True
    for i in straight_ids:
        e=ends.setdefault(i,{})
        if 's' not in e: e['s']=proj(lines[i],V[i])
        if 'e' not in e: e['e']=proj(lines[i],V[(i+1)%n])
    first=straight_ids[0]
    out.append(('M',ends[first]['s']))
    for j,i in enumerate(straight_ids):
        out.append(('L',ends[i]['e']))
        nxt=straight_ids[(j+1)%m]
        if (i+1)%n!=nxt and not ends[i].get('sharp'):
            a=vidx[(i+1)%n]; b=vidx[nxt]
            pts=C[a:b+1] if b>=a else np.vstack([C[a:],C[:b+1]])
            e0,s0=ends[i]['e'],ends[nxt]['s']
            keep=(np.hypot(*(pts-e0).T)>0.3)&(np.hypot(*(pts-s0).T)>0.3)
            Li=np.hypot(*(ends[i]['e']-ends[i]['s'])); Ln=np.hypot(*(ends[nxt]['e']-ends[nxt]['s']))
            da=min(DELTA,0.35*Li); db=min(DELTA,0.35*Ln)
            ea=e0-t0_*da if (t0_:=lines[i][1]) is not None else e0
            sb=s0+lines[nxt][1]*db
            la=np.linspace(0,1,6)[:-1,None]
            P=np.vstack([ea+(e0-ea)*la, pts[keep], s0+(sb-s0)*np.r_[la[1:],[[1.0]]]])
            P=smooth_open(P,SMOOTH)
            out[-1]=('L',ea); ends[nxt]['s']=sb; nxt_start_override[nxt]=sb
            t0=lines[i][1]; t1=lines[nxt][1]
            out+=fit_rec(P,t0,t1)
    if first in nxt_start_override: out[0]=('M',nxt_start_override[first])
    return out

def trace_region(alpha,box,up=8,sigma=0.55,thr=0.5):
    """alpha float 0..1 da imagem inteira; box=(x0,y0,x1,y1) em px; devolve contornos em px"""
    x0,y0,x1,y1=box
    sub=alpha[y0:y1,x0:x1]
    big=np.array(Image.fromarray((sub*255).astype(np.uint8)).resize((sub.shape[1]*up,sub.shape[0]*up),Image.BICUBIC)).astype(float)/255
    big=nd.gaussian_filter(big,sigma*up)
    cs=measure.find_contours(np.pad(big,2),thr)
    res=[]
    for c in cs:
        pts=np.c_[(c[:,1]-2+0.5)/up+x0-0.5/up*0, (c[:,0]-2+0.5)/up+y0]
        if len(pts)>20: res.append(pts)
    return res

# ---------------------------------------------------------------------------
# Saída SVG e linha de comando
# ---------------------------------------------------------------------------
def contornos_para_path(lista, T=lambda p: p):
    """lista de comandos (saída de contour_to_path) -> pathops.Path sem sobreposição.
    Cada contorno é simplificado sozinho e combinado por XOR (furos viram furos)."""
    import pathops
    acc = pathops.Path()
    for cmds in lista:
        p = pathops.Path()
        for c in cmds:
            if c[0] == 'M': p.moveTo(*T(c[1]))
            elif c[0] == 'L': p.lineTo(*T(c[1]))
            else: p.cubicTo(*T(c[1]), *T(c[2]), *T(c[3]))
        p.close(); p.simplify()
        acc = pathops.op(acc, p, pathops.PathOp.XOR)
    return acc

def limpar(alpha, caixa, sigma=0.55, angtol=7, diag=8.0, T=lambda p: p):
    """alpha 0..1 (1 = forma). Devolve pathops.Path limpo da região caixa=(x0,y0,x1,y1) em px."""
    global DIAG
    antigo = globals().get('DIAG', 8.0); DIAG = diag
    try:
        cs = trace_region(alpha, caixa, sigma=sigma)
        return contornos_para_path([contour_to_path(c, angtol=angtol) for c in cs], T)
    finally:
        DIAG = antigo

def path_para_d(path):
    from fontTools.pens.svgPathPen import SVGPathPen
    pen = SVGPathPen(None, ntos=lambda v: ('%.3f' % v).rstrip('0').rstrip('.'))
    path.draw(pen); return pen.getCommands()

if __name__ == '__main__':
    import argparse, os
    ap = argparse.ArgumentParser(description='Contorno limpo a partir do pixel: retas retas, curvas contínuas, cantos vivos. '
                                 'Mantém o desenho original (não troca por fonte).')
    ap.add_argument('imagem', help='PNG com transparência (forma opaca) ou imagem escura sobre fundo claro')
    ap.add_argument('--saida', default='.')
    ap.add_argument('--cor', default='#000000')
    ap.add_argument('--caixa', help='x0,y0,x1,y1 em px (padrão: imagem inteira)')
    ap.add_argument('--sigma', type=float, default=0.55, help='suavização em px (0,55 letras; 0,8 formas grandes)')
    ap.add_argument('--diag', type=float, default=8.0, help='tamanho mínimo (px) para aceitar reta inclinada; formas grandes ~25')
    ap.add_argument('--angtol', type=float, default=7.0, help='graus de tolerância para travar reta na horizontal/vertical')
    ap.add_argument('--inverter', action='store_true', help='forçar forma = área clara')
    a = ap.parse_args()
    im = Image.open(a.imagem)
    if im.mode in ('RGBA', 'LA') and np.array(im.split()[-1]).min() < 250:
        alpha = np.array(im.split()[-1]).astype(float) / 255
    else:
        alpha = 1 - np.array(im.convert('L')).astype(float) / 255
    if a.inverter: alpha = 1 - alpha
    H, W = alpha.shape
    caixa = tuple(int(v) for v in a.caixa.split(',')) if a.caixa else (0, 0, W, H)
    p = limpar(alpha, caixa, a.sigma, a.angtol, a.diag)
    hexa = a.cor.lstrip('#').upper()
    os.makedirs(a.saida, exist_ok=True)
    nome = os.path.join(a.saida, os.path.splitext(os.path.basename(a.imagem))[0] + '-limpo.svg')
    open(nome, 'w').write(f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<g id="cor-1_{hexa}" fill="#{hexa}"><path d="{path_para_d(p)}"/></g>
</svg>
''')
    print(nome)
