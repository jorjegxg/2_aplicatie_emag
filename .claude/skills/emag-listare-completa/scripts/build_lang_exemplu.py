#!/usr/bin/env python3
"""EXEMPLU REAL (PARF-SOL-NEGRU, id 57, 2026-10-03) — copiază-l în directorul de lucru al produsului și adaptează-l.
Uz: build_lang.py <ro|hu|bg>   (citește texte.json {ro,hu,bg}; „cm” devine „см” în BG prin cheia "cm")

Structura directorului de lucru (în scratchpad):
  img/       pozele furnizorului deja încărcate (copiate din /var/www/poze/_catalog/<stored_name>)
  aliA/ ...  pozele noi descărcate cu descarca_imagini.py
  fonts/     OpenSans-Bold.ttf, OpenSans-ExtraBold.ttf
  texte.json textele pe limbi
  out/<lang>/01..08.jpg + out/sheet_<lang>.jpg
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, "/home/base/2_aplicatie_emag/.claude/skills/emag-listare-completa/scripts")
from galerie_common import *  # noqa
from PIL import Image, ImageDraw, ImageFilter

LANG = sys.argv[1]
T = json.load(open(os.path.join(HERE, "texte.json"), encoding="utf-8"))[LANG]
img = lambda n: Image.open(os.path.join(HERE, "img", n)).convert("RGB")
PROD = cutout(os.path.join(HERE, "img", "NG.jpg"))
RING = Image.open(os.path.join(HERE, "ring.png"))  # tableta parfumată decupată din poza furnizorului

# NG1 curățat: crop care scoate logo-ul „zhanhao” (stânga-jos, 240x240), apoi bandă închisă peste textul englezesc
NG1 = img("NG1.jpg").crop((240, 240, 2000, 2000)).resize((N, N), Image.LANCZOS)
dark_top(NG1, 420, 600)
NG2 = img("NG2.jpg")

imgs = [g_main(PROD)]

# 2. dorință
c = NG1.copy()
d = ImageDraw.Draw(c)
text_left(d, 100, 150, T["p2_title"], fit(T["p2_title"], N - 200, 140, MIN_TITLE, extra=True), WHITE)
text_left(d, 100, 330, T["p2_sub"], fit(T["p2_sub"], N - 200, 90, MIN_LABEL), GOLD)
imgs.append(c)

# 3. dimensiuni desenate pe decupaj (aceleași cote ca la modelul auriu: 10,5 / 7,5 / 5,3 cm)
c = Image.new("RGB", (N, N), WHITE)
title_band(c, T["p3_title"], 0, 330)
d = ImageDraw.Draw(c)
p = scale_to(PROD, w=1450)
px0, py0 = 230, 520
c.paste(p, (px0, py0), p)
pw, ph = p.size
a = p.getchannel("A")
row = int(ph * 0.86)
xs = [x for x in range(pw) if a.getpixel((x, row)) > 128]
bx0, bx1 = px0 + min(xs), px0 + max(xs)
bot = py0 + ph
LC, LW = DARK, 8
cm = T["cm"]
lf = font(84, extra=True)


def hline(x0, x1, y):
    d.line([(x0, y), (x1, y)], fill=LC, width=LW)
    for x in (x0, x1):
        d.line([(x, y - 35), (x, y + 35)], fill=LC, width=LW)


hline(bx0, bx1, bot + 110)
pill_label(d, ((bx0 + bx1) / 2 - 190, bot + 55, (bx0 + bx1) / 2 + 190, bot + 165), f"7,5 {cm}", lf)
hline(px0, px0 + pw, bot + 330)
pill_label(d, (px0 + pw / 2 - 210, bot + 275, px0 + pw / 2 + 210, bot + 385), f"10,5 {cm}", lf)
vx = px0 + pw + 90
d.line([(vx, py0), (vx, bot)], fill=LC, width=LW)
for y in (py0, bot):
    d.line([(vx - 35, y), (vx + 35, y)], fill=LC, width=LW)
vpill(c, (int(vx - 70), int((py0 + bot) / 2 - 190)), 380, f"5,3 {cm}", lf)
imgs.append(c)

# 4. panouri solare, 5. corp din aliaj
# vedere de sus din Alibaba aliA/g04: crop SUB textul englezesc (nu „picta” rândurile — lasă dungi)
TOP = upsharp(Image.open(os.path.join(HERE, "aliA", "g04.jpg")).convert("RGB").crop((40, 248, 760, 800)), w=N)
imgs.append(g_crop_titled(TOP, (0, 0, N, 1200), T["p4_title"], T["p4_label"]))
imgs.append(g_white_titled(cutout(os.path.join(HERE, "aliB/g01.jpg")), T["p5_title"], T["p5_label"]))  # alt unghi, Alibaba
# 6. pachet, 7. cum funcționează, 8. pentru cine
imgs.append(g_package(PROD, RING, T))
imgs.append(g_how(T, NG1, (300, 420, 1880, 2000), NG2, (560, 780, 1760, 1980)))
imgs.append(g_for_whom(upsharp(cutout(os.path.join(HERE, "aliB/g05.jpg")), w=1250), T))  # alt unghi, Alibaba

save_all(imgs, os.path.join(HERE, "out", LANG), os.path.join(HERE, "out", f"sheet_{LANG}.jpg"))
print("ok", LANG)
