# Cum au fost măsurate cifrele (septembrie 2026)

## Trafic pe mobil

- De Black Friday 2025, 87,75% dintre clienți au intrat de pe mobil: https://about.emag.ro/2025/11/07/emag-black-friday-dupa-trei-ore-comenzi-de-609-milioane-de-lei-si-peste-2-milioane-de-produse-vandute/
- Pentru comparație, în 2016 mobilul avea ~56% din vizite și o treime din comenzi, deci ponderea a crescut constant.

## Limita titlului

Câmpul `name` din API-ul eMAG Marketplace acceptă un string de 1–255 caractere: https://s13emagst.akamaized.net/layout/hu/static-upload/emag-marketplace-api-documentation-v4-4-4.pdf

## Cât se vede din titlu în căutare

**Stilul titlului.** CSS-ul emag.ro (`Listing-*.min.css`) setează:

- `.card-v2 .card-v2-title-wrapper`: font-size 14px, font-weight 600, line-height 19px;
- `.card-v2 .card-v2-title`: `-webkit-line-clamp: 3`, height 57px, deci maximum 3 rânduri;
- `.rec-card-item .card-v2 .card-v2-title` (carusele): 2 rânduri.

Fontul este Open Sans SemiBold 600.

**Lățimea cardului:**

| Ecran | Lățime card |
|---|---|
| Mobil | `.page-container .card-item`: 50% din ecran |
| ≥992px | 237px |
| ≥1260px | 242px |
| ≥1530px | 302px |

**Lățimea textului** = lățimea cardului − padding (`.card-item` 3px pe mobil și 5px pe desktop, `.card-v2` 1px, `.card-v2-content` 10px pe fiecare parte):

| Ecran | Lățime text | Observație |
|---|---|---|
| 360px | 147px | Estimat, ±5px pentru padding-ul containerului |
| 390px | 162px | Estimat, ±5px pentru padding-ul containerului |
| 412px | 173px | Estimat, ±5px pentru padding-ul containerului |
| Laptop 1366–1529px | 210px | |
| Monitor 1920px | 270px | |

**Simularea.** Lățimile caracterelor au fost extrase din fontul Open Sans SemiBold la 14px în `scripts/latimi_font_emag.json`. Fontul nu are kerning aplicat, deci suma lățimilor e identică cu măsurarea PIL. Word-wrap-ul e reprodus ca în browser.

**Validarea.** Pe cele 60 de rezultate de la „perna lombara”:
- 59 din 60 de titluri sunt tăiate pe mobil;
- lungimea mediană e de 198 de caractere;
- partea vizibilă (mediană): 50 de caractere la 360px, 58 la 390px, 62 la 412px, 77 pe laptop și 103 pe monitorul de 1920px.

## Re-măsurare (dacă eMAG schimbă designul)

1. Descarcă o pagină de căutare: `curl -sL -A "<UA desktop>" https://www.emag.ro/search/<termen> -o d.html`.
2. Ia fișierele CSS din `<link rel="stylesheet">` și caută `card-v2-title` și `.page-container .card-item`.
3. Dacă se schimbă fontul, mărimea sau numărul de rânduri, regenerează `latimi_font_emag.json`. Folosește PIL `ImageFont.truetype(<ttf>, <px>).getlength(c)` pentru fiecare caracter.
4. Actualizează `ECRANE` și `RANDURI_CARD` în `scripts/verifica_listare.py` și tabelul din `SKILL.md`.

Aplicația nativă eMAG nu poate fi măsurată așa. Pentru ea verifici manual pe telefon, numărând caracterele vizibile ale unui titlu lung.

## Mărimea textului din infografice

- Pe pagina de produs pe telefon, imaginea e afișată pe toată lățimea, adică ~390px.
- 2000px / 390px ≈ 5,1, deci 1px pe ecran înseamnă ~5px în imagine.
- Un text lizibil pe telefon are 12–16px, adică ~60–80px în imagine.
- Un titlu de 24px pe telefon înseamnă ~120px în imagine.
