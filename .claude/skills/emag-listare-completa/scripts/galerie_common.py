"""Helperi pentru galeriile eMAG de 2000x2000 (doar PIL; nu există numpy/cv2).

Importă-l din build_lang.py:
    sys.path.insert(0, "<calea către .claude/skills/emag-listare-completa/scripts>")
    from galerie_common import *
Fonturile OpenSans (Bold, ExtraBold) se caută în $GALERIE_FONTS sau în ./fonts din directorul curent.
"""
import math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

N = 2000
DARK = (24, 24, 28)
GOLD = (212, 163, 58)
WHITE = (255, 255, 255)
BAND = (18, 20, 26)
MIN_TITLE, MIN_LABEL = 120, 60
_FONTS = os.environ.get("GALERIE_FONTS") or os.path.join(os.getcwd(), "fonts")


def font(size, extra=False):
    return ImageFont.truetype(os.path.join(_FONTS, "OpenSans-ExtraBold.ttf" if extra else "OpenSans-Bold.ttf"), size)


def _d():
    return ImageDraw.Draw(Image.new("RGB", (10, 10)))


def fit(text, maxw, size, minsize, extra=False):
    d = _d()
    while size >= minsize:
        f = font(size, extra)
        b = d.textbbox((0, 0), text, font=f)
        if b[2] - b[0] <= maxw:
            return f
        size -= 2
    raise SystemExit(f"text prea lung (sub {minsize}px): {text!r}")


def text_center(d, cx, cy, text, f, fill):
    b = d.textbbox((0, 0), text, font=f)
    d.text((cx - (b[0] + b[2]) / 2, cy - (b[1] + b[3]) / 2), text, font=f, fill=fill)


def text_left(d, x, cy, text, f, fill):
    b = d.textbbox((0, 0), text, font=f)
    d.text((x - b[0], cy - (b[1] + b[3]) / 2), text, font=f, fill=fill)


def wrap(text, maxw, size, minsize, extra=False):
    d = _d()
    f = font(size, extra)
    if d.textlength(text, font=f) <= maxw:
        return [text], f
    w = text.split()
    best = None
    for i in range(1, len(w)):
        a, c = " ".join(w[:i]), " ".join(w[i:])
        m = max(d.textlength(a, font=f), d.textlength(c, font=f))
        if best is None or m < best[0]:
            best = (m, [a, c])
    lines = best[1]
    f = fit(max(lines, key=lambda s: d.textlength(s, font=f)), maxw, size, minsize, extra)
    return lines, f


def scale_to(im, w=None, h=None):
    if w:
        h = round(im.size[1] * w / im.size[0])
    else:
        w = round(im.size[0] * h / im.size[1])
    return im.resize((w, h), Image.LANCZOS)


def cutout(path):
    """Produs pe fundal alb -> RGBA decupat (flood-fill al albului legat de margini)."""
    im = Image.open(path).convert("RGB")
    g = im.convert("L").point(lambda v: 255 if v > 242 else 0)
    W, H = im.size
    for s in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1), (W // 2, 0), (W // 2, H - 1), (0, 200), (W - 1, 200), (0, H - 200), (W - 1, H - 200)]:
        if g.getpixel(s) == 255:
            ImageDraw.floodfill(g, s, 128)
    alpha = g.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1))
    rgba = im.copy()
    rgba.putalpha(alpha)
    return rgba.crop(alpha.getbbox())


def dark_top(im, opaque_to, fade_to, color=BAND):
    """Bandă de titlu închisă peste toată lățimea, cu trecere lină."""
    top = Image.new("RGB", (im.size[0], fade_to), color)
    m = Image.new("L", (im.size[0], fade_to), 255)
    md = ImageDraw.Draw(m)
    for y in range(opaque_to, fade_to):
        md.line([(0, y), (im.size[0], y)], fill=int(255 * (fade_to - y) / (fade_to - opaque_to)))
    im.paste(top, (0, 0), m)


def white_top(im, opaque_to, fade_to):
    top = Image.new("RGB", (im.size[0], fade_to), WHITE)
    m = Image.new("L", (im.size[0], fade_to), 255)
    md = ImageDraw.Draw(m)
    for y in range(opaque_to, fade_to):
        md.line([(0, y), (im.size[0], y)], fill=int(255 * (fade_to - y) / (fade_to - opaque_to)))
    im.paste(top, (0, 0), m)


def title_band(canvas, text, y0=0, h=330, bg=WHITE, fg=DARK):
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, y0, N, y0 + h], fill=bg)
    f = fit(text, N - 200, 150, MIN_TITLE, extra=True)
    text_center(d, N / 2, y0 + h / 2, text, f, fg)


def circle_num(d, cx, cy, n, r=70):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD)
    text_center(d, cx, cy, str(n), font(96 if n < 10 else 72, extra=True), WHITE)


def pill_label(d, box, text, f):
    d.rounded_rectangle(box, radius=30, fill=WHITE)
    text_center(d, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, text, f, DARK)


def vpill(canvas, xy, length, text, f):
    v = Image.new("RGBA", (length, 140), (0, 0, 0, 0))
    vd = ImageDraw.Draw(v)
    vd.rounded_rectangle([0, 0, length - 1, 139], radius=30, fill=WHITE + (255,))
    text_center(vd, length / 2, 70, text, f, DARK)
    v = v.rotate(90, expand=True)
    canvas.paste(v, xy, v)


# ---- galerii-tip ----

def g_main(prod):
    c = Image.new("RGB", (N, N), WHITE)
    p = scale_to(prod, w=1760)
    c.paste(p, ((N - p.size[0]) // 2, (N - p.size[1]) // 2), p)
    return c


def g_crop_titled(src, box, title, label, label_fg=WHITE):
    c = Image.new("RGB", (N, N), WHITE)
    crop = scale_to(src.crop(box), w=N)
    c.paste(crop, (0, 360))
    title_band(c, title, 0, 360)
    d = ImageDraw.Draw(c)
    y = 360 + crop.size[1]
    d.rectangle([0, y, N, N], fill=DARK)
    text_center(d, N / 2, (y + N) / 2, label, fit(label, N - 200, 100, MIN_LABEL), label_fg)
    return c


def g_package(prod, ring, T):
    c = Image.new("RGB", (N, N), WHITE)
    title_band(c, T["p6_title"], 0, 330)
    d = ImageDraw.Draw(c)
    p = scale_to(prod, w=1180)
    py = 1040 - p.size[1] // 2
    c.paste(p, (100, py), p)
    r = scale_to(ring, h=470)
    rx, ry = 1440 + (420 - r.size[0]) // 2, 1040 - r.size[1] // 2
    c.paste(r, (rx, ry), r)
    circle_num(d, 170, py - 10, 1)
    circle_num(d, 1480, ry - 10, 2)
    for cx, key, mw in [(690, "p6_l1", 860), (1650, "p6_l2", 600)]:
        lines, f = wrap(T[key], mw, 84, MIN_LABEL, extra=True)
        for k, ln in enumerate(lines):
            text_center(d, cx, 1600 + k * 105, ln, f, DARK)
    return c


def g_how(T, src1, box1, src3, box3):
    c = Image.new("RGB", (N, N), WHITE)
    title_band(c, T["p7_title"], 0, 300)
    d = ImageDraw.Draw(c)
    R = 250

    def circ(src, box, cx, cy):
        im = src.crop(box).resize((2 * R, 2 * R), Image.LANCZOS)
        m = Image.new("L", (2 * R, 2 * R), 0)
        ImageDraw.Draw(m).ellipse([0, 0, 2 * R - 1, 2 * R - 1], fill=255)
        c.paste(im, (cx - R, cy - R), m)
        d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=GOLD, width=10)

    rows = [560, 1110, 1660]
    circ(src1, box1, 380, rows[0])
    cx, cy = 380, rows[1]
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(255, 244, 214), outline=GOLD, width=10)
    for k in range(12):
        a = k * math.pi / 6
        d.line([(cx + 120 * math.cos(a), cy + 120 * math.sin(a)), (cx + 200 * math.cos(a), cy + 200 * math.sin(a))], fill=(240, 170, 20), width=22)
    d.ellipse([cx - 95, cy - 95, cx + 95, cy + 95], fill=(250, 190, 30))
    circ(src3, box3, 380, rows[2])
    for k, (cy, key) in enumerate(zip(rows, ["p7_s1", "p7_s2", "p7_s3"])):
        circle_num(d, 760, cy, k + 1, r=66)
        lines, f = wrap(T[key], 1080, 96, MIN_LABEL, extra=True)
        for j, ln in enumerate(lines):
            text_left(d, 870, cy + (j - (len(lines) - 1) / 2) * 118, ln, f, DARK)
    return c


def g_for_whom(prod, T):
    c = Image.new("RGB", (N, N), WHITE)
    title_band(c, T["p8_title"], 0, 300)
    d = ImageDraw.Draw(c)
    p = scale_to(prod, w=1250)
    c.paste(p, ((N - p.size[0]) // 2, 330), p)
    y = 330 + p.size[1] + 120
    for key in ["p8_l1", "p8_l2", "p8_l3"]:
        cx = 220
        d.ellipse([cx - 62, y - 62, cx + 62, y + 62], fill=GOLD)
        d.line([(cx - 32, y + 2), (cx - 8, y + 28), (cx + 34, y - 26)], fill=WHITE, width=18, joint="curve")
        text_left(d, 330, y, T[key], fit(T[key], 1550, 92, MIN_LABEL, extra=True), DARK)
        y += 200
    return c


def banner_ring(c, ring, text, y0=1755, y1=1995):
    d = ImageDraw.Draw(c)
    d.rounded_rectangle([140, y0, 1875, y1], radius=40, fill=GOLD)
    r = scale_to(ring, h=y1 - y0 + 140)
    c.paste(r, (150, y0 - 110), r)
    f = fit(text, 1400, 88, MIN_LABEL, extra=True)
    text_center(d, 1150, (y0 + y1) / 2, text, f, DARK)


def save_all(imgs, out_dir, sheet_path):
    os.makedirs(out_dir, exist_ok=True)
    for i, im in enumerate(imgs, 1):
        assert im.size == (N, N)
        im.convert("RGB").save(os.path.join(out_dir, f"{i:02d}.jpg"), quality=92, subsampling=0)
    W = 500
    sh = Image.new("RGB", (W * 4, W * 2), WHITE)
    for i, im in enumerate(imgs):
        sh.paste(im.convert("RGB").resize((W, W), Image.LANCZOS), ((i % 4) * W, (i // 4) * W))
    sh.save(sheet_path, quality=88)


def upsharp(im, w=None, h=None):
    """Mărire din pozele mici Alibaba (750-800px) + sharpen ușor."""
    return scale_to(im, w=w, h=h).filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))


def g_white_titled(prod, title, label, label_fg=GOLD):
    """Produs decupat pe alb, titlu sus, etichetă pe bandă închisă jos."""
    c = Image.new("RGB", (N, N), WHITE)
    title_band(c, title, 0, 330)
    p = prod if prod.size[0] >= 1650 else upsharp(prod, w=1650)
    p = scale_to(p, w=1650)
    if p.size[1] > 1150:
        p = scale_to(p, h=1150)
    c.paste(p, ((N - p.size[0]) // 2, 330 + (1330 - p.size[1]) // 2), p)
    d = ImageDraw.Draw(c)
    d.rectangle([0, 1680, N, N], fill=DARK)
    text_center(d, N / 2, 1840, label, fit(label, N - 200, 100, MIN_LABEL), label_fg)
    return c



def g_pieces(items, title):
    """„Ce primești în cutie” pentru N piese: items = [(RGBA decupat, eticheta), ...].
    Grilă automată (1-3 coloane), cifre în cercuri centrate după textbbox (font mai mic la 2 cifre)."""
    c = Image.new("RGB", (N, N), WHITE)
    title_band(c, title, 0, 330)
    d = ImageDraw.Draw(c)
    n = len(items)
    cols = 1 if n == 1 else 2 if n <= 4 else 3
    rows = (n + cols - 1) // cols
    cw, ch = (N - 160) // cols, (N - 330 - 60) // rows
    for k, (im, label) in enumerate(items):
        x0, y0 = 80 + (k % cols) * cw, 350 + (k // cols) * ch
        lines, f = wrap(label, cw - 40, 80 if rows < 3 else 64, MIN_LABEL, extra=True)
        lab_h = len(lines) * (f.size + 20)
        box_w, box_h = cw - 60, ch - lab_h - 60
        p = im.copy()
        p.thumbnail((box_w, box_h), Image.LANCZOS)
        px, py = x0 + (cw - p.size[0]) // 2, y0 + 20 + (box_h - p.size[1]) // 2
        c.paste(p, (px, py), p if p.mode == "RGBA" else None)
        circle_num(d, x0 + 70, y0 + 70, k + 1, r=60)
        for j, ln in enumerate(lines):
            text_center(d, x0 + cw / 2, y0 + 20 + box_h + 30 + j * (f.size + 20), ln, f, DARK)
    return c
