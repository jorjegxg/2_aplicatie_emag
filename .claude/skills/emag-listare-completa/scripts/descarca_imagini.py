#!/usr/bin/env python3
"""Descarcă pozele furnizorului la REZOLUȚIA MAXIMĂ și face contact sheet.

Uz:
  descarca_imagini.py <dir_iesire> <prefix> URL [URL ...]
  descarca_imagini.py <dir_iesire> <prefix> --json fisier.json   # JSON de la alibaba_imagini.js (gal/col/desc)

- Scoate sufixele de miniatură de pe alicdn (s.alicdn.com, sc0X.alicdn.com, ae01.alicdn.com):
  X.jpg_960x960q80.jpg, X.jpg_100x100.jpg, X.jpg_.webp, X.jpg_640x640q90.jpg_.webp  ->  X.jpg (originalul).
- Sare peste ce nu e imagine și peste duplicate (același conținut), păstrând varianta cea mai mare.
- Scrie <dir_iesire>/<prefix>NN.<ext> și <dir_iesire>_sheet.jpg (etichetă = nume + rezoluție).
"""
import hashlib, io, json, os, re, sys, urllib.request
from PIL import Image, ImageDraw

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36"
SUFFIX = re.compile(r"(\.(?:jpe?g|png|webp|avif))(?:_[^/]*)?$", re.I)


def original(url):
    url = url.strip().strip("\"'(")
    if url.startswith("//"):
        url = "https:" + url
    return SUFFIX.sub(r"\1", url.split("?")[0])


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.alibaba.com/"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main():
    out, prefix = sys.argv[1], sys.argv[2]
    rest = sys.argv[3:]
    if rest and rest[0] == "--json":
        j = json.load(open(rest[1]))
        urls = []
        for key, p in (("gal", "g"), ("col", "c"), ("desc", "d"), ("imgs", "d")):
            urls += [(p, u) for u in j.get(key, [])]
    else:
        urls = [("", u) for u in rest]
    os.makedirs(out, exist_ok=True)
    seen = {}
    saved = []
    n = 0
    for p, u in urls:
        u0 = original(u)
        try:
            data = fetch(u0)
            im = Image.open(io.BytesIO(data))
            im.load()
        except Exception:
            try:  # unele CDN-uri dau originalul doar pe URL-ul primit
                data = fetch(u if u.startswith("http") else "https:" + u)
                im = Image.open(io.BytesIO(data))
                im.load()
            except Exception as e:
                print("SKIP", u0, e)
                continue
        h = hashlib.md5(im.convert("RGB").resize((32, 32)).tobytes()).hexdigest()
        if h in seen and seen[h][1] >= im.size[0] * im.size[1]:
            print("DUP ", u0)
            continue
        n += 1
        ext = (im.format or "JPEG").lower().replace("jpeg", "jpg")
        name = f"{prefix}{p}{n:02d}.{ext}"
        open(os.path.join(out, name), "wb").write(data)
        seen[h] = (name, im.size[0] * im.size[1])
        saved.append((name, im.size, u0))
        print(f"{name}\t{im.size[0]}x{im.size[1]}\t{u0}")
    # contact sheet
    W, cols = 360, 6
    rows = max(1, (len(saved) + cols - 1) // cols)
    sh = Image.new("RGB", (W * cols, (W + 28) * rows), "white")
    d = ImageDraw.Draw(sh)
    for k, (name, size, _) in enumerate(saved):
        im = Image.open(os.path.join(out, name)).convert("RGB")
        im.thumbnail((W, W))
        x, y = (k % cols) * W, (k // cols) * (W + 28)
        sh.paste(im, (x + (W - im.size[0]) // 2, y + 28))
        d.text((x + 4, y + 6), f"{name} {size[0]}x{size[1]}", fill=(220, 0, 0))
    sheet = out.rstrip("/") + "_sheet.jpg"
    sh.save(sheet, quality=85)
    json.dump([{"file": a, "w": b[0], "h": b[1], "url": c} for a, b, c in saved], open(os.path.join(out, "_index.json"), "w"), indent=1)
    print("sheet:", sheet, "| salvate:", len(saved))


if __name__ == "__main__":
    main()
