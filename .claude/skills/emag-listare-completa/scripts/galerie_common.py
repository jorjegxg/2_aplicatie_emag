"""Helperi pentru galeriile eMAG de 2000x2000 (doar PIL; nu există numpy/cv2).

Importă-l din build_lang.py:
    sys.path.insert(0, "<calea către .claude/skills/emag-listare-completa/scripts>")
    from galerie_common import *

Stilul (aprobat de utilizator, „ca pe Amazon”, discret):
- titluri: Playfair Display SemiBold, MAJUSCULE, litere ușor spațiate, auriu în degradeu pe bandă închisă
  (sau cerneală pe crem), cu o linie fină și un romb sub titlu;
- restul textului: Montserrat Medium; SemiBold doar pentru pastile, cifre și etichete scurte.
  Niciodată Bold/ExtraBold/Black, contur sau umbră pe text;
- paletă: cerneală #16181E, crem #F6F2EA, auriu #C8983A, gri cald, alb.
Fonturile (variabile, cu diacritice RO/HU și chirilică) sunt în ../fonts sau în $GALERIE_FONTS.

Rezoluția: pozele se pun DOAR prin photo(), care refuză mărirea peste 2× și raportează tot ce trece de 1,5×.
Cercurile, pastilele și liniile oblice se desenează netezit (aa_*), nu cu ImageDraw direct.
"""
import io, math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps, features

try:
    from PIL import ImageCms
except ImportError:  # fără littlecms: pozele rămân cum sunt
    ImageCms = None

N = 2000
INK = (22, 24, 30)
CREAM = (246, 242, 234)
GOLD = (200, 152, 58)
GOLD_TOP, GOLD_BOT = (250, 222, 150), (190, 138, 48)
GREY = (112, 108, 100)
LIGHT = (232, 230, 226)
WHITE = (255, 255, 255)
DARK = BAND = INK  # nume vechi
MIN_TITLE, MIN_LABEL = 120, 60

W_TITLE = 600  # Playfair Display SemiBold
W_TEXT = 500   # Montserrat Medium
W_EMPH = 600   # Montserrat SemiBold
TRACK_TITLE = 0.04  # spațierea literelor din titlu, în em
# Playfair are implicit cifre „old-style” (2, 3, 6 mai mici decât majusculele); în titluri vrem cifre de înălțimea majusculelor
LNUM = ["lnum"] if features.check("raqm") else None

UPSCALE_WARN, UPSCALE_MAX = 1.5, 2.0
RAPORT = []  # (rol, sursă WxH, țintă WxH, factor)

_HERE = os.path.dirname(os.path.abspath(__file__))
_FONTS = os.environ.get("GALERIE_FONTS") or os.path.join(_HERE, "..", "fonts")
SANS = os.path.join(_FONTS, "Montserrat[wght].ttf")
SERIF = os.path.join(_FONTS, "PlayfairDisplay[wght].ttf")
_FC = {}
SS = 4  # supraeșantionare pentru forme netezite


# ---------- fonturi ----------

def _vf(path, size, weight):
    k = (path, int(size), weight)
    if k not in _FC:
        f = ImageFont.truetype(path, int(size))
        f.set_variation_by_axes([weight])
        _FC[k] = f
    return _FC[k]


def font(size, extra=False, weight=None):
    """Montserrat: Medium implicit, SemiBold cu extra=True."""
    return _vf(SANS, size, weight or (W_EMPH if extra else W_TEXT))


def tfont(size, weight=W_TITLE):
    """Playfair Display pentru titluri."""
    return _vf(SERIF, size, weight)


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
    raise SystemExit(f"text prea lung (sub {minsize}px): {text!r} — scurtează textul")


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


# ---------- titluri ----------

def title_img(text, size, color="gold", upper=True):
    """Titlu Playfair cu litere spațiate. color="gold" = degradeu auriu, altfel un RGB.
    Întoarce (RGBA, y-ul centrului majusculelor)."""
    text = text.upper() if upper else text
    f = tfont(size)
    tr = size * TRACK_TITLE
    dd = _d()
    ws = [dd.textlength(ch, font=f, features=LNUM) for ch in text]
    W = int(sum(ws) + tr * (len(text) - 1)) + 8
    pad = int(size * 0.5)
    H = int(size * 1.4) + 2 * pad
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    x = 0.0
    for ch, w in zip(text, ws):
        md.text((x, pad), ch, font=f, fill=255, features=LNUM)
        x += w + tr
    hb = f.getbbox("H")
    yc = pad + (hb[1] + hb[3]) / 2
    if color == "gold":
        g = Image.new("RGB", (1, H))
        y0, y1 = pad + hb[1], pad + hb[3]
        for y in range(H):
            t = min(1, max(0, (y - y0) / max(1, y1 - y0)))
            g.putpixel((0, y), tuple(int(GOLD_TOP[i] + (GOLD_BOT[i] - GOLD_TOP[i]) * t) for i in range(3)))
        fill = g.resize((W, H))
    else:
        fill = Image.new("RGB", (W, H), color)
    out = fill.convert("RGBA")
    out.putalpha(m)
    return out, yc


def title_fit(text, maxw, size=132, minsize=MIN_TITLE, color="gold", upper=True):
    while size >= minsize:
        im, yc = title_img(text, size, color, upper)
        if im.size[0] <= maxw:
            return im, yc
        size -= 4
    raise SystemExit(f"titlu prea lung (sub {minsize}px): {text!r} — scurtează textul, nu micșora fontul")


def put_title(c, cx, cy, text, maxw=N - 200, size=132, minsize=MIN_TITLE, color="gold", upper=True):
    im, yc = title_fit(text, maxw, size, minsize, color, upper)
    c.paste(im, (int(cx - im.size[0] / 2), int(cy - yc)), im)


def ornament(c, cx, cy, color=GOLD):
    """Linie fină + romb sub titlu."""
    aa_line(c, [(cx - 230, cy), (cx - 42, cy)], color, 4)
    aa_line(c, [(cx + 42, cy), (cx + 230, cy)], color, 4)
    aa_polygon(c, [(cx, cy - 16), (cx + 16, cy), (cx, cy + 16), (cx - 16, cy)], color)


def head(c, title, sub=None, h=330, dark=True, y0=0):
    """Banda de titlu standard: închisă cu titlu auriu (dark=True) sau crem cu titlu cerneală."""
    bg = INK if dark else CREAM
    d = ImageDraw.Draw(c)
    d.rectangle([0, y0, N, y0 + h], fill=bg)
    col = "gold" if dark else INK
    if sub:
        put_title(c, N / 2, y0 + h * 0.38, title, color=col)
        text_center(d, N / 2, y0 + h * 0.78, sub, fit(sub, N - 200, 72, MIN_LABEL), LIGHT if dark else GREY)
    else:
        put_title(c, N / 2, y0 + h * 0.43, title, color=col)
        ornament(c, N / 2, y0 + h * 0.80)


def title_band(canvas, text, y0=0, h=330, bg=INK, fg=None):
    """Compatibilitate: bandă de titlu în stilul nou (fundal deschis -> titlu cerneală)."""
    head(canvas, text, h=h, dark=sum(bg) < 300, y0=y0)


# ---------- forme netezite ----------

def _img(t):
    return t if isinstance(t, Image.Image) else t._image


def _paste_mask(c, ox, oy, w, h, color, draw_fn):
    m = Image.new("L", (w * SS, h * SS), 0)
    draw_fn(ImageDraw.Draw(m), lambda x, y: ((x - ox) * SS, (y - oy) * SS))
    m = m.resize((w, h), Image.LANCZOS)
    c.paste(Image.new(c.mode, (w, h), color if c.mode == "RGB" else tuple(color[:3]) + (255,)), (ox, oy), m)


def aa_shape(target, box, shape="ellipse", fill=None, outline=None, width=0, radius=0):
    """Elipsă sau dreptunghi rotunjit cu margini netede (ImageDraw nu netezește formele)."""
    c = _img(target)
    x0, y0, x1, y1 = box
    p = int(width) + 4
    ox, oy = int(math.floor(x0)) - p, int(math.floor(y0)) - p
    w, h = int(math.ceil(x1)) + p - ox, int(math.ceil(y1)) + p - oy

    def draw(fv, ov, wd):
        def fn(md, tr):
            b = [*tr(x0, y0), *tr(x1, y1)]
            if shape == "ellipse":
                md.ellipse(b, fill=fv, outline=ov, width=int(wd * SS))
            else:
                md.rounded_rectangle(b, radius=int(radius * SS), fill=fv, outline=ov, width=int(wd * SS))
        return fn

    if fill is not None:
        _paste_mask(c, ox, oy, w, h, fill, draw(255, None, 0))
    if outline is not None and width:
        _paste_mask(c, ox, oy, w, h, outline, draw(None, 255, width))


def aa_line(target, pts, fill, width):
    c = _img(target)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    pad = int(width) + 4
    ox, oy = int(min(xs)) - pad, int(min(ys)) - pad
    w, h = int(max(xs)) + pad - ox, int(max(ys)) + pad - oy
    _paste_mask(c, ox, oy, w, h, fill, lambda md, tr: md.line([tr(*p) for p in pts], fill=255, width=int(width * SS), joint="curve"))


def aa_polygon(target, pts, fill):
    c = _img(target)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    ox, oy = int(min(xs)) - 4, int(min(ys)) - 4
    w, h = int(max(xs)) + 4 - ox, int(max(ys)) + 4 - oy
    _paste_mask(c, ox, oy, w, h, fill, lambda md, tr: md.polygon([tr(*p) for p in pts], fill=255))


def circle_num(d, cx, cy, n, r=64, bg=GOLD, fg=WHITE):
    aa_shape(d, [cx - r, cy - r, cx + r, cy + r], fill=bg)
    text_center(ImageDraw.Draw(_img(d)), cx, cy, str(n), font(int(r * (1.15 if n < 10 else 0.9)), extra=True), fg)


def check_icon(d, cx, cy, r=58, bg=GOLD, fg=WHITE):
    aa_shape(d, [cx - r, cy - r, cx + r, cy + r], fill=bg)
    s = r / 62
    aa_line(d, [(cx - 30 * s, cy + 2 * s), (cx - 8 * s, cy + 25 * s), (cx + 32 * s, cy - 24 * s)], fg, 13 * s)


def pill_label(d, box, text, f, bg=WHITE, fg=INK):
    aa_shape(d, box, "rect", fill=bg, radius=(box[3] - box[1]) / 2)
    text_center(ImageDraw.Draw(_img(d)), (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, text, f, fg)


def gold_pill(d, cx, cy, text, size=80, fg=INK, bg=GOLD, padx=70, h=140):
    f = fit(text, N - 260, size, MIN_LABEL, extra=True)
    w = _d().textlength(text, font=f)
    pill_label(d, [cx - w / 2 - padx, cy - h / 2, cx + w / 2 + padx, cy + h / 2], text, f, bg, fg)


def vpill(canvas, xy, length, text, f, bg=WHITE, fg=INK, h=130):
    """Pastilă verticală (pentru cote pe înălțime)."""
    col = Image.new("RGB", (length, h), bg)
    text_center(ImageDraw.Draw(col), length / 2, h / 2, text, f, fg)
    m = Image.new("L", (length * SS, h * SS), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, length * SS - 1, h * SS - 1], radius=h * SS // 2, fill=255)
    m = m.resize((length, h), Image.LANCZOS)
    canvas.paste(col.rotate(90, expand=True), xy, m.rotate(90, expand=True))


def shadow(c, cx, y, w, h=70, op=80):
    """Umbră moale sub produs (dă volum pe alb/crem)."""
    s = Image.new("L", (N, N), 0)
    ImageDraw.Draw(s).ellipse([cx - w / 2, y - h / 2, cx + w / 2, y + h / 2], fill=op)
    s = s.filter(ImageFilter.GaussianBlur(28))
    c.paste(Image.new("RGB", (N, N), (0, 0, 0)), (0, 0), s)


# ---------- poze și rezoluție ----------

def load(path):
    """Deschide o poză: rotire EXIF, conversie în sRGB dacă are alt profil ICC."""
    im = ImageOps.exif_transpose(Image.open(path))
    icc = im.info.get("icc_profile")
    alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    im = im.convert("RGBA" if alpha else "RGB")
    if icc and ImageCms:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            if "srgb" not in ImageCms.getProfileName(src).lower():
                rgb = ImageCms.profileToProfile(im.convert("RGB"), src, ImageCms.createProfile("sRGB"))
                if alpha:
                    rgb.putalpha(im.getchannel("A"))
                im = rgb
        except Exception:
            pass
    return im


def scale_to(im, w=None, h=None):
    if w:
        h = round(im.size[1] * w / im.size[0])
    else:
        w = round(im.size[0] * h / im.size[1])
    return im.resize((w, h), Image.LANCZOS)


def photo(im, w=None, h=None, rol="", max_up=UPSCALE_MAX):
    """Redimensionează o poză pentru galerie, cu control de calitate.
    ≤1×: micșorare LANCZOS + sharpen fin; 1–2×: mărire LANCZOS + sharpen dozat după factor;
    >max_up: oprește scriptul (caută sursă mai mare sau pune poza într-un cadru mai mic)."""
    tw = w or round(im.size[0] * h / im.size[1])
    k = tw / im.size[0]
    th = round(im.size[1] * k)
    RAPORT.append((rol or "?", im.size, (tw, th), k))
    if k > max_up + 1e-6:
        raise SystemExit(
            f"rezoluție insuficientă pentru „{rol}”: {im.size[0]}x{im.size[1]} -> {tw}x{th} = {k:.2f}× (max {max_up}×). "
            f"Caută sursa mai mare sau pune poza la cel mult {int(im.size[0] * max_up)}px lățime.")
    out = im.resize((tw, th), Image.LANCZOS)
    if k <= 1:
        return out.filter(ImageFilter.UnsharpMask(radius=1, percent=35, threshold=3))
    return out.filter(ImageFilter.UnsharpMask(radius=1.2 + k, percent=int(40 + 30 * (k - 1)), threshold=3))


def upsharp(im, w=None, h=None, rol=""):
    """Nume vechi pentru photo()."""
    return photo(im, w=w, h=h, rol=rol)


def cutout(path):
    """Produs pe fundal alb -> RGBA decupat (flood-fill al albului legat de margini)."""
    im = load(path).convert("RGB")
    g = im.convert("L").point(lambda v: 255 if v > 242 else 0)
    W, H = im.size
    for s in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1), (W // 2, 0), (W // 2, H - 1),
              (0, H // 10), (W - 1, H // 10), (0, H - H // 10), (W - 1, H - H // 10)]:
        if g.getpixel(s) == 255:
            ImageDraw.floodfill(g, s, 128)
    alpha = g.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1))
    rgba = im.copy()
    rgba.putalpha(alpha)
    return rgba.crop(alpha.getbbox())


def dark_top(im, opaque_to, fade_to, color=INK):
    """Bandă de titlu închisă peste toată lățimea, cu trecere lină."""
    top = Image.new("RGB", (im.size[0], fade_to), color)
    m = Image.new("L", (im.size[0], fade_to), 255)
    md = ImageDraw.Draw(m)
    for y in range(opaque_to, fade_to):
        md.line([(0, y), (im.size[0], y)], fill=int(255 * ((fade_to - y) / (fade_to - opaque_to)) ** 1.6))
    im.paste(top, (0, 0), m)


def white_top(im, opaque_to, fade_to):
    dark_top(im, opaque_to, fade_to, WHITE)


# ---------- galerii-tip ----------

def g_main(prod):
    c = Image.new("RGB", (N, N), WHITE)
    p = photo(prod, w=1740, rol="1 principala")
    if p.size[1] > 1740:
        p = photo(prod, h=1740, rol="1 principala")
    y = (N - p.size[1]) // 2
    shadow(c, N / 2, y + p.size[1] - 20, p.size[0] * 0.6, 70, 60)
    c.paste(p, ((N - p.size[0]) // 2, y), p)
    return c


def g_crop_titled(src, box, title, label, label_fg=INK):
    c = Image.new("RGB", (N, N), INK)
    crop = photo(src.crop(box), w=N, rol=title)
    c.paste(crop.crop((0, 0, N, min(crop.size[1], 1350))), (0, 330))
    head(c, title)
    d = ImageDraw.Draw(c)
    d.rectangle([0, 1680, N, N], fill=INK)
    gold_pill(c, N / 2, 1840, label, fg=label_fg)
    return c


def g_package(prod, ring, T):
    c = Image.new("RGB", (N, N), CREAM)
    head(c, T["p6_title"])
    d = ImageDraw.Draw(c)
    p = photo(prod, w=1180, rol="6 pachet: produs")
    py = 1040 - p.size[1] // 2
    shadow(c, 100 + p.size[0] / 2, py + p.size[1] - 20, p.size[0] * 0.6, 60, 55)
    c.paste(p, (100, py), p)
    r = photo(ring, h=470, rol="6 pachet: accesoriu")
    rx, ry = 1440 + (420 - r.size[0]) // 2, 1040 - r.size[1] // 2
    c.paste(r, (rx, ry), r)
    circle_num(c, 170, py - 10, 1)
    circle_num(c, 1480, ry - 10, 2)
    for cx, key, mw in [(690, "p6_l1", 860), (1650, "p6_l2", 600)]:
        lines, f = wrap(T[key], mw, 80, MIN_LABEL, extra=True)
        for k, ln in enumerate(lines):
            text_center(d, cx, 1600 + k * 104, ln, f, INK)
    return c


def g_how(T, src1, box1, src3, box3):
    c = Image.new("RGB", (N, N), CREAM)
    head(c, T["p7_title"])
    d = ImageDraw.Draw(c)
    R = 250

    def circ(src, box, cx, cy):
        im = photo(src.crop(box), w=2 * R, rol=T["p7_title"])
        m = Image.new("L", (2 * R * SS, 2 * R * SS), 0)
        ImageDraw.Draw(m).ellipse([0, 0, 2 * R * SS - 1, 2 * R * SS - 1], fill=255)
        c.paste(im.crop((0, 0, 2 * R, 2 * R)), (cx - R, cy - R), m.resize((2 * R, 2 * R), Image.LANCZOS))
        aa_shape(c, [cx - R, cy - R, cx + R, cy + R], outline=GOLD, width=10)

    rows = [600, 1140, 1680]
    circ(src1, box1, 380, rows[0])
    cx, cy = 380, rows[1]
    aa_shape(c, [cx - R, cy - R, cx + R, cy + R], fill=(255, 246, 222), outline=GOLD, width=10)
    for k in range(12):
        a = k * math.pi / 6
        aa_line(c, [(cx + 120 * math.cos(a), cy + 120 * math.sin(a)), (cx + 195 * math.cos(a), cy + 195 * math.sin(a))], (236, 172, 40), 18)
    aa_shape(c, [cx - 92, cy - 92, cx + 92, cy + 92], fill=(246, 190, 52))
    circ(src3, box3, 380, rows[2])
    for k, (cy, key) in enumerate(zip(rows, ["p7_s1", "p7_s2", "p7_s3"])):
        circle_num(c, 760, cy, k + 1)
        lines, f = wrap(T[key], 1080, 88, MIN_LABEL)
        for j, ln in enumerate(lines):
            text_left(d, 870, cy + (j - (len(lines) - 1) / 2) * 112, ln, f, INK)
    return c


def g_for_whom(prod, T):
    c = Image.new("RGB", (N, N), CREAM)
    head(c, T["p8_title"])
    d = ImageDraw.Draw(c)
    p = photo(prod, w=1250, rol="8 pentru cine")
    if p.size[1] > 900:
        p = photo(prod, h=900, rol="8 pentru cine")
    c.paste(p, ((N - p.size[0]) // 2, 400), p)
    y = 400 + p.size[1] + 140
    for key in ["p8_l1", "p8_l2", "p8_l3"]:
        check_icon(c, 220, y)
        text_left(d, 330, y, T[key], fit(T[key], 1550, 84, MIN_LABEL), INK)
        y += 190
    return c


def banner_ring(c, ring, text, y0=1755, y1=1995):
    aa_shape(c, [140, y0, 1875, y1], "rect", fill=GOLD, radius=(y1 - y0) / 2)
    r = photo(ring, h=y1 - y0 + 140, rol="banner accesoriu")
    c.paste(r, (150, y0 - 110), r)
    f = fit(text, 1400, 80, MIN_LABEL, extra=True)
    text_center(ImageDraw.Draw(c), 1150, (y0 + y1) / 2, text, f, INK)


def g_white_titled(prod, title, label, label_fg=INK):
    """Produs decupat pe crem, titlu sus, pastilă aurie pe bandă închisă jos."""
    c = Image.new("RGB", (N, N), CREAM)
    head(c, title)
    p = photo(prod, w=1650, rol=title)
    if p.size[1] > 1150:
        p = photo(prod, h=1150, rol=title)
    y = 330 + (1350 - p.size[1]) // 2
    shadow(c, N / 2, y + p.size[1] - 20, p.size[0] * 0.6, 60, 55)
    c.paste(p, ((N - p.size[0]) // 2, y), p)
    ImageDraw.Draw(c).rectangle([0, 1680, N, N], fill=INK)
    gold_pill(c, N / 2, 1840, label, fg=label_fg)
    return c


def g_pieces(items, title):
    """„Ce primești în cutie” pentru N piese: items = [(RGBA decupat, eticheta), ...].
    Grilă automată (1-3 coloane), cifre în cercuri centrate după textbbox (font mai mic la 2 cifre)."""
    c = Image.new("RGB", (N, N), CREAM)
    head(c, title)
    d = ImageDraw.Draw(c)
    n = len(items)
    cols = 1 if n == 1 else 2 if n <= 4 else 3
    rows = (n + cols - 1) // cols
    cw, ch = (N - 160) // cols, (N - 330 - 60) // rows
    for k, (im, label) in enumerate(items):
        x0, y0 = 80 + (k % cols) * cw, 350 + (k // cols) * ch
        lines, f = wrap(label, cw - 40, 76 if rows < 3 else 64, MIN_LABEL, extra=True)
        lab_h = len(lines) * (f.size + 20)
        box_w, box_h = cw - 60, ch - lab_h - 60
        kk = min(box_w / im.size[0], box_h / im.size[1])
        p = photo(im, w=max(1, int(im.size[0] * kk)), rol=f"piesa {k + 1}")
        px, py = x0 + (cw - p.size[0]) // 2, y0 + 20 + (box_h - p.size[1]) // 2
        c.paste(p, (px, py), p if p.mode == "RGBA" else None)
        circle_num(c, x0 + 70, y0 + 70, k + 1, r=56)
        for j, ln in enumerate(lines):
            text_center(d, x0 + cw / 2, y0 + 20 + box_h + 30 + j * (f.size + 20), ln, f, INK)
    return c


# ---------- salvare și verificare ----------

def raport_rezolutie():
    """Tabelul cu factorul de mărire al fiecărei poze; ⚠ peste 1,5×."""
    for rol, s, t, k in RAPORT:
        flag = "⚠ " if k > UPSCALE_WARN else "  "
        print(f"{flag}{k:4.2f}×  {s[0]}x{s[1]} -> {t[0]}x{t[1]}  {rol}")


def save_all(imgs, out_dir, sheet_path, max_mb=5.5):
    """JPG calitate 95, 4:4:4, progresiv, sRGB; contact sheet + crop-uri 1:1 (<sheet>_1la1.jpg)."""
    os.makedirs(out_dir, exist_ok=True)
    for i, im in enumerate(imgs, 1):
        assert im.size == (N, N), im.size
        path = os.path.join(out_dir, f"{i:02d}.jpg")
        for q in (95, 93, 90, 88):
            im.convert("RGB").save(path, quality=q, subsampling=0, optimize=True, progressive=True)
            if os.path.getsize(path) <= max_mb * 1e6:
                break
    W = 500
    sh = Image.new("RGB", (W * 4, W * 2), WHITE)
    for i, im in enumerate(imgs):
        sh.paste(im.convert("RGB").resize((W, W), Image.LANCZOS), ((i % 4) * W, (i // 4) * W))
    sh.save(sheet_path, quality=90)
    # 1:1, fără micșorare: zona titlului și centrul fiecărei poze, ca să se vadă claritatea reală
    Z, G = 500, 16
    z = Image.new("RGB", (Z * 4 + G * 3, Z * 4 + G * 3), (255, 0, 120))
    for i, im in enumerate(imgs):
        x, y = (i % 4) * (Z + G), (i // 4) * 2 * (Z + G)
        z.paste(im.convert("RGB").crop((N // 2 - Z // 2, 40, N // 2 + Z // 2, 40 + Z)), (x, y))
        z.paste(im.convert("RGB").crop((N // 2 - Z // 2, N // 2 - Z // 2, N // 2 + Z // 2, N // 2 + Z // 2)), (x, y + Z + G))
    z.save(os.path.splitext(sheet_path)[0] + "_1la1.jpg", quality=90)
    raport_rezolutie()
