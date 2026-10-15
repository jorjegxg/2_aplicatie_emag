#!/usr/bin/env python3
"""EXEMPLU REAL (56 PARF-SOL-AURIU, 2026-10-15, stil aprobat) — copiază-l în directorul de lucru al produsului și adaptează-l.
Uz: build_lang.py <ro|hu|bg>   (citește texte.json {ro,hu,bg}; „cm” devine „см” în BG prin cheia "cm")

Structura directorului de lucru (în scratchpad):
  src/ it34/ ...  pozele furnizorului (din aplicație și descărcate cu descarca_imagini.py)
  texte.json      textele pe limbi (vezi texte_exemplu.json)
  out/<lang>/01..08.jpg + out/sheet_<lang>.jpg + out/sheet_<lang>_1la1.jpg
Fonturile vin din skill (../fonts); nu le copia.

Reguli: toate pozele trec prin photo() (refuză mărirea peste 2×); titlurile prin head()/put_title();
textul prin font() (Montserrat Medium/SemiBold). Nu folosi ImageDraw.ellipse/rounded_rectangle direct: aa_shape().
"""
import json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, "/home/base/2_aplicatie_emag/.claude/skills/emag-listare-completa/scripts")
from galerie_common import *  # noqa
from PIL import Image, ImageChops, ImageDraw, ImageEnhance

LANG = sys.argv[1]
T = json.load(open(os.path.join(HERE, "texte.json"), encoding="utf-8"))[LANG]
src = lambda *p: load(os.path.join(HERE, *p))

PROD = cutout(os.path.join(HERE, "src", "en_0.jpg"))  # 2000px, varianta aurie pe alb
CLEAN = src("it34_clean.png")  # 1601px, fără inel/pipetă/insignă (curățat pixel cu pixel, nu watermark)
DASH = photo(CLEAN.crop((272, 12, 1601, 1341)), w=N, rol="2 pe bord")  # 1329px -> 2000 (1,5×)
NIGHT = src("src", "en_2.jpg")  # panouri solare
GOLDV = src("it34", "a04.jpg")  # 1601px
imgs = []

# 1. principala: pe alb, fără text, umbră moale
imgs.append(g_main(PROD))

# 2. dorință: poza reală + titlu pe două rânduri, al doilea mai mare
c = DASH.copy()
dark_top(c, 420, 760)
put_title(c, N / 2, 150, T["p2_t1"], size=120)
put_title(c, N / 2, 330, T["p2_t2"], size=180, minsize=140)
text_center(ImageDraw.Draw(c), N / 2, 500, T["p2_sub"], fit(T["p2_sub"], N - 200, 76, MIN_LABEL), LIGHT)
imgs.append(c)

# 3. dimensiuni la scară + card bancar ca reper
c = Image.new("RGB", (N, N), CREAM)
head(c, T["p3_title"])
d = ImageDraw.Draw(c)
pxcm = 112
p = photo(PROD, w=int(10.5 * pxcm), rol="3 dimensiuni")
px, py = (N - p.size[0]) // 2 - 70, 470
c.paste(p, (px, py), p)
a = p.getchannel("A")
row = int(p.size[1] * 0.86)
xs = [x for x in range(p.size[0]) if a.getpixel((x, row)) > 128]
bx0, bx1 = px + xs[0], px + xs[-1]
f = font(76, extra=True)


def dim_h(x0, x1, y, text):
    d.line([(x0, y), (x1, y)], fill=INK, width=6)
    for x in (x0, x1):
        d.line([(x, y - 30), (x, y + 30)], fill=INK, width=6)
    w = d.textlength(text, font=f)
    cx = (x0 + x1) / 2
    d.rectangle([cx - w / 2 - 30, y - 60, cx + w / 2 + 30, y + 60], fill=CREAM)
    text_center(d, cx, y, text, f, INK)


def dim_v(x, y0, y1, text):
    d.line([(x, y0), (x, y1)], fill=INK, width=6)
    for y in (y0, y1):
        d.line([(x - 30, y), (x + 30, y)], fill=INK, width=6)
    w = int(d.textlength(text, font=f)) + 60
    vpill(c, (int(x - 60), int((y0 + y1) / 2 - w / 2)), w, text, f, bg=CREAM, h=120)


cm = T["cm"]
dim_h(px, px + p.size[0], py - 40, f"10,5 {cm}")
dim_h(bx0, bx1, py + p.size[1] + 70, f"7,5 {cm}")
dim_v(px + p.size[0] + 110, py, py + p.size[1], f"5,3 {cm}")
cw, ch = int(8.56 * pxcm), int(5.4 * pxcm)
cx0, cy0 = (N - cw) // 2, 1300
aa_shape(c, [cx0, cy0, cx0 + cw, cy0 + ch], "rect", fill=(228, 222, 210), outline=(196, 188, 172), width=5, radius=44)
aa_shape(c, [cx0 + 90, cy0 + 150, cx0 + 230, cy0 + 255], "rect", fill=(214, 178, 96), radius=16)
lines, f2 = wrap(T["p3_ref"], cw - 160, 68, MIN_LABEL)
for j, ln in enumerate(lines):
    text_left(d, cx0 + 90, cy0 + 380 + j * 90, ln, f2, GREY)
imgs.append(c)

# 4. mecanism: crop din poza reală (1620px -> 2000 = 1,23×)
c = Image.new("RGB", (N, N), INK)
c.paste(photo(NIGHT.crop((380, 500, 2000, 1600)), w=N, rol="4 panouri"), (0, 330))
head(c, T["p4_title"])
gold_pill(c, N / 2, 1840, T["p4_label"])
imgs.append(c)

# 5. detaliu: 1201px -> 2000 = 1,67× (apare cu ⚠ în raport: verifică crop-ul 1:1)
c = Image.new("RGB", (N, N), INK)
cr = photo(CLEAN.crop((400, 480, 1601, 1290)), w=N, rol="5 detaliu")
c.paste(cr, (0, 330 + max(0, (1350 - cr.size[1]) // 2)))
head(c, T["p5_title"])
ImageDraw.Draw(c).rectangle([0, 1680, N, N], fill=INK)
gold_pill(c, N / 2, 1840, T["p5_label"])
imgs.append(c)


# 6. ce primești în cutie (accesoriul desenat după dimensiunile reale, pentru că nu exista poză curată)
def tablet(w):
    """Tableta parfumată (inel alb Ø 4,7 cm, gaură 2,8 cm), desenată în perspectivă la 4× și micșorată."""
    W, H = w * SS, int(w * 0.62) * SS
    th = int(0.07 * W)
    im = Image.new("RGBA", (W, H + th), (0, 0, 0, 0))
    dd = ImageDraw.Draw(im)
    side = (214, 212, 206, 255)
    dd.ellipse([0, th, W, H + th], fill=side)
    dd.rectangle([0, H / 2, W, H / 2 + th], fill=side)
    dd.ellipse([0, 0, W, H], fill=(252, 252, 250, 255))
    iw, ih, cx, cy = W * 28 / 47, H * 28 / 47, W / 2, H / 2
    hole = Image.new("L", im.size, 0)
    ImageDraw.Draw(hole).ellipse([cx - iw / 2, cy - ih / 2, cx + iw / 2, cy + ih / 2], fill=255)
    lower = Image.new("L", im.size, 0)
    ImageDraw.Draw(lower).ellipse([cx - iw / 2, cy - ih / 2 + th, cx + iw / 2, cy + ih / 2 + th], fill=255)
    im.putalpha(ImageChops.subtract(im.getchannel("A"), ImageChops.multiply(hole, lower)))
    im.paste(Image.new("RGBA", im.size, (200, 198, 192, 255)), (0, 0), ImageChops.subtract(hole, lower))
    ImageDraw.Draw(im).ellipse([0, 0, W, H], outline=(225, 223, 218, 255), width=SS * 3)
    return im.resize((w, im.size[1] // SS), Image.LANCZOS)


c = Image.new("RGB", (N, N), CREAM)
head(c, T["p6_title"])
d = ImageDraw.Draw(c)
p = photo(PROD, w=1200, rol="6 pachet")
shadow(c, 650, 520 + p.size[1] - 20, 760, 60, 55)
c.paste(p, (90, 520), p)
tb = tablet(int(4.7 / 10.5 * 1200 * 1.05))
tx, ty = N - 110 - tb.size[0], 520 + p.size[1] - tb.size[1] - 40  # marginea de 100px
shadow(c, tx + tb.size[0] / 2, ty + tb.size[1] - 10, tb.size[0] * 0.9, 50, 45)
c.paste(tb, (tx, ty), tb)
circle_num(c, 150, 470, 1)
circle_num(c, tx + 30, ty - 60, 2)
for cx, key, mw in [(690, "p6_l1", 1100), (tx + tb.size[0] // 2, "p6_l2", 620)]:
    lines, f = wrap(T[key], mw, 80, MIN_LABEL, extra=True)
    for k, ln in enumerate(lines):
        text_center(d, cx, 1560 + k * 104, ln, f, INK)
n2 = len(wrap(T["p6_l2"], 620, 80, MIN_LABEL, extra=True)[0])
text_center(d, tx + tb.size[0] // 2, 1560 + 104 * n2 + 10, T["p6_l2b"], fit(T["p6_l2b"], 600, 68, MIN_LABEL), GREY)
imgs.append(c)

# 7. limita spusă cinstit: soare / umbră
c = Image.new("RGB", (N, N), INK)
ph = DASH.crop((0, 300, N, 300 + 1670))
right = ImageEnhance.Brightness(ph.crop((N // 2, 0, N, ph.size[1]))).enhance(0.34)
ph.paste(Image.blend(right, Image.new("RGB", right.size, (18, 28, 60)), 0.35), (N // 2, 0))
c.paste(ph, (0, 330))
head(c, T["p7_title"])
d = ImageDraw.Draw(c)
d.line([(N // 2, 330), (N // 2, N)], fill=WHITE, width=6)
for cx, k1, k2, col in [(N // 4, "p7_sun", "p7_sun2", GOLD), (3 * N // 4, "p7_shade", "p7_shade2", WHITE)]:
    aa_shape(c, [cx - 440, 1640, cx + 440, 1940], "rect", fill=INK, radius=40)
    text_center(d, cx, 1730, T[k1], fit(T[k1], 800, 92, MIN_LABEL, extra=True), col)
    text_center(d, cx, 1855, T[k2], fit(T[k2], 800, 68, MIN_LABEL), LIGHT)
imgs.append(c)

# 8. cum îl folosești: 3 pași în cercuri
c = Image.new("RGB", (N, N), CREAM)
head(c, T["p8_title"])
d = ImageDraw.Draw(c)
R, rows = 260, [610, 1150, 1690]


def circ(im, cx, cy, rol):
    im = photo(im, w=2 * R, rol=rol).crop((0, 0, 2 * R, 2 * R))
    m = Image.new("L", (2 * R * SS, 2 * R * SS), 0)
    ImageDraw.Draw(m).ellipse([0, 0, 2 * R * SS - 1, 2 * R * SS - 1], fill=255)
    c.paste(im, (cx - R, cy - R), m.resize((2 * R, 2 * R), Image.LANCZOS))
    aa_shape(c, [cx - R, cy - R, cx + R, cy + R], outline=GOLD, width=10)


s1 = Image.new("RGB", (900, 900), WHITE)
bp = photo(PROD, w=760, rol="8 pas 1")
s1.paste(bp, (70, 900 - bp.size[1] - 90), bp)
tb2 = tablet(420)
s1.paste(tb2, (240, 90), tb2)
aa_line(s1, [(450, 360), (450, 440)], GOLD, 20)
aa_polygon(s1, [(450, 485), (400, 425), (500, 425)], GOLD)
circ(s1, 380, rows[0], "8 pas 1")
circ(CLEAN.crop((440, 230, 1601, 1391)), 380, rows[1], "8 pas 2")
s3 = GOLDV.crop((600, 430, 1580, 1410)).copy()
sx, sy = 830, 150
for k in range(12):
    an = k * math.pi / 6
    aa_line(s3, [(sx + 70 * math.cos(an), sy + 70 * math.sin(an)), (sx + 115 * math.cos(an), sy + 115 * math.sin(an))], (246, 190, 52), 14)
aa_shape(s3, [sx - 55, sy - 55, sx + 55, sy + 55], fill=(246, 190, 52))
circ(s3, 380, rows[2], "8 pas 3")
for k, (cy, key) in enumerate(zip(rows, ["p8_s1", "p8_s2", "p8_s3"])):
    circle_num(c, 770, cy, k + 1)
    lines, f = wrap(T[key], 1060, 88, MIN_LABEL)
    for j, ln in enumerate(lines):
        text_left(d, 880, cy + (j - (len(lines) - 1) / 2) * 112, ln, f, INK)
imgs.append(c)

save_all(imgs, os.path.join(HERE, "out", LANG), os.path.join(HERE, "out", f"sheet_{LANG}.jpg"))
print("ok", LANG)
