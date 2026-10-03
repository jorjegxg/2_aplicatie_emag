#!/usr/bin/env python3
"""Verifică textele unei listări eMAG după regulile din SKILL.md.

Utilizare:
  python3 verifica_listare.py titlu "Perna lombara pentru scaun auto si birou, ..."
  python3 verifica_listare.py descriere descriere.txt      (sau "-" pentru stdin)
  python3 verifica_listare.py infografic "Titlu imagine" "eticheta 1" "eticheta 2"

Simularea titlului folosește lățimile reale ale fontului din cardul eMAG
(Open Sans SemiBold 14px, max 3 rânduri — clasa .card-v2-title), măsurate în
septembrie 2026. Vezi references/masuratori.md.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

LATIMI = json.loads((Path(__file__).parent / "latimi_font_emag.json").read_text(encoding="utf-8"))
LATIME_IMPLICITA = 8.2  # caracter necunoscut ≈ media literelor mici

# Lățimea textului din card = lățime card − padding (3/5px card-item, 1px card-v2, 10px conținut).
ECRANE = [
    ("Telefon 360px", 147),
    ("iPhone 390px", 162),
    ("Android 412px", 173),
    ("Laptop 1366-1529", 210),
    ("Monitor 1920", 270),
]
RANDURI_CARD = 3

CUVINTE_PROMO = [
    "reducere", "reduceri", "promotie", "oferta", "gratuit", "gratis", "livrare",
    "cel mai bun", "cea mai buna", "cele mai bune", "premium", "calitate superioara",
    "super", "top", "garantie", "stoc limitat", "cumpara", "lichidare", "bestseller",
    "best seller", "nou", "noua", "exclusiv", "ieftin", "pret",
]
CUVINTE_MEDICALE = [
    "vindeca", "trateaza", "tratament", "hernie", "elimina durerea", "scapa definitiv",
    "medical", "ortopedic", "terapeutic", "vindecare",
]
ACRONIME_OK = {"USB", "LED", "HDMI", "BPA", "PVC", "RGB", "MDF", "ABS", "TPU", "EVA",
               "XXL", "XXXL", "IPX", "UV", "LCD", "WIFI", "GSM", "SUV"}
SIMBOLURI_OK = set("×–—’‘“”„…®™°²³½€")


def fara_diacritice(text):
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn").lower()


def cauta_cuvinte(text, lista):
    simplu = fara_diacritice(text)
    return [c for c in lista if re.search(r"(?<![a-z])" + re.escape(c) + r"(?![a-z])", simplu)]


def latime_caracter(c):
    if c in LATIMI:
        return LATIMI[c]
    return 0 if unicodedata.category(c) in ("Mn", "Cf") else LATIME_IMPLICITA


def latime(text):
    return sum(latime_caracter(c) for c in text)


def rupe_pe_randuri(text, latime_max, randuri=RANDURI_CARD):
    """Reproduce word-wrap-ul din browser; întoarce (rânduri vizibile, e_tăiat)."""
    out, rand = [], ""
    for cuvant in text.split():
        candidat = (rand + " " + cuvant).strip()
        if latime(candidat) <= latime_max or not rand:
            rand = candidat
        else:
            out.append(rand)
            rand = cuvant
            if len(out) == randuri:
                return out, True
    out.append(rand)
    return out, False


def zona(text, limita):
    if len(text) <= limita:
        return text
    taiat = text[:limita]
    return taiat[: taiat.rfind(" ")] if " " in taiat else taiat


def verifica_titlu(titlu):
    titlu = " ".join(titlu.split())
    car, cuv = len(titlu), len(titlu.split())
    print(f"Titlu: {car} caractere, {cuv} cuvinte  (ținta 80–120 caractere / 12–17 cuvinte)")
    print(f'Zona A (car. 1–50, o văd toți):  "{zona(titlu, 50)}"')
    print(f'Zona B (51–80, laptop):          "{zona(titlu, 80)[len(zona(titlu, 50)):].strip()}"')
    print()
    print("Ce se vede în rezultatele căutării (14px, max 3 rânduri):")
    for nume, px in ECRANE:
        randuri, taiat = rupe_pe_randuri(titlu, px)
        vizibil = " ".join(randuri)
        coada = "…" if taiat else ""
        print(f"  {nume:17} {len(vizibil):3} car. / {len(vizibil.split()):2} cuv. | {' / '.join(randuri)}{coada}")
    print()

    probleme = []
    if car > 255:
        probleme.append(f"EROARE: {car} caractere — eMAG acceptă maximum 255.")
    elif car > 150:
        probleme.append("Peste 150 de caractere: restul nu se vede nicăieri în căutare și arată a spam. Mută keyword-urile în caracteristici/descriere.")
    elif car < 80:
        probleme.append("Sub 80 de caractere: ai loc de dovadă, dimensiune sau culoare.")
    majuscule = [w for w in re.findall(r"[^\W\d_]{4,}", titlu) if w.isupper() and w not in ACRONIME_OK]
    if majuscule:
        probleme.append(f"Cuvinte scrise cu MAJUSCULE: {', '.join(majuscule)}")
    promo = cauta_cuvinte(titlu, CUVINTE_PROMO)
    if promo:
        probleme.append(f"Cuvinte promoționale/interzise în titlu: {', '.join(promo)}")
    medical = cauta_cuvinte(titlu, CUVINTE_MEDICALE)
    if medical:
        probleme.append(f"Posibilă promisiune medicală (risc de respingere): {', '.join(medical)}")
    simboluri = sorted({c for c in titlu if not (c.isalnum() or c in " ,.-/()%+&'\"x:" or c in SIMBOLURI_OK)})
    if simboluri or "!" in titlu:
        probleme.append(f"Simboluri/emoji de scos: {' '.join(simboluri)}")
    if re.search(r"\d\s*\*\s*\d", titlu):
        probleme.append("Dimensiuni cu '*': scrie 38x33 cm.")
    numar = r"\d+(?:[.,]\d+)?"
    for m in re.finditer(rf"{numar}\s*[x×]\s*{numar}(?:\s*[x×]\s*{numar})?", titlu):
        if not re.match(r"\s*(cm|mm|m|ml|l)\b", titlu[m.end():]):
            probleme.append(f"Dimensiune fără unitate de măsură: {m.group(0)} (adaugă cm/mm).")
    if re.search(r"[şţŞŢ]", titlu):
        probleme.append("Diacritice cu sedilă (ş ţ): folosește ș ț (cu virgulă).")
    if re.search(r"[ăâîșțĂÂÎȘȚ]", titlu):
        probleme.append("Titlul are diacritice: păstrează aceeași alegere (cu sau fără) în tot catalogul.")
    print("Avertismente:" if probleme else "Avertismente: niciunul.")
    for p in probleme:
        print(f"  - {p}")


def verifica_descriere(text):
    blocuri = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    total = len(text.split())
    print(f"Descriere: {total} cuvinte  (ținta 200–350)")
    probleme = []
    if total < 200:
        probleme.append("Sub 200 de cuvinte: probabil lipsesc 'Pentru cine', întreținere sau conținutul pachetului.")
    elif total > 350:
        probleme.append("Peste 350 de cuvinte: pe telefon nu se citește; taie repetițiile.")
    for bloc in blocuri:
        for linie in bloc.splitlines():
            linie = linie.strip()
            if re.match(r"^([-•*✓]|\d+[.)])\s+", linie):
                n = len(linie.split()) - 1
                if n > 20:
                    probleme.append(f"Bullet de {n} cuvinte (max 20): \"{linie[:60]}…\"")
        if not re.match(r"^([-•*✓]|\d+[.)])\s+", bloc):
            n = len(bloc.split())
            if n > 40:
                probleme.append(f"Paragraf de {n} cuvinte (max 40 ≈ 3 rânduri pe telefon): \"{bloc[:60]}…\"")
    if re.search(r"https?://|www\.|\.(ro|com|eu)\b", text, re.I):
        probleme.append("Link sau site extern — interzis în descriere.")
    if re.search(r"@\w+\.\w+|\b0\d{3}[\s.-]?\d{3}[\s.-]?\d{3}\b", text):
        probleme.append("Date de contact (email/telefon) — interzise.")
    if re.search(r"\d+([.,]\d+)?\s*(lei|ron)\b", fara_diacritice(text)):
        probleme.append("Preț în descriere — interzis.")
    promo = cauta_cuvinte(text, ["reducere", "promotie", "oferta limitata", "cumpara acum", "stoc limitat",
                                 "livrare gratuita", "garantie", "super oferta", "cel mai bun", "cea mai buna"])
    if promo:
        probleme.append(f"Mesaje promoționale / informații de ofertă: {', '.join(promo)}")
    medical = cauta_cuvinte(text, CUVINTE_MEDICALE)
    if medical:
        probleme.append(f"Posibile promisiuni medicale: {', '.join(medical)} — formulează ca beneficiu de confort.")
    print("Avertismente:" if probleme else "Avertismente: niciunul.")
    for p in probleme:
        print(f"  - {p}")


def verifica_infografic(titlu, etichete):
    total = len(titlu.split()) + sum(len(e.split()) for e in etichete)
    print(f"Infografic: titlu {len(titlu.split())} cuv. (max 5), {len(etichete)} etichete (max 3), total {total} cuv. (max 20)")
    print("Pe canvas 2000x2000: titlu ≥120px, etichete ≥80px, nimic sub 60px, margine liberă ~100px.")
    probleme = []
    if len(titlu.split()) > 5:
        probleme.append("Titlul imaginii are peste 5 cuvinte.")
    if len(etichete) > 3:
        probleme.append("Peste 3 etichete: o singură idee pe imagine.")
    for e in etichete:
        if len(e.split()) > 4:
            probleme.append(f"Eticheta are peste 4 cuvinte: \"{e}\"")
    if total > 20:
        probleme.append("Peste 20 de cuvinte pe imagine: nu se citește pe telefon.")
    promo = cauta_cuvinte(" ".join([titlu, *etichete]), CUVINTE_PROMO)
    if promo:
        probleme.append(f"Text promoțional pe imagine: {', '.join(promo)}")
    print("Avertismente:" if probleme else "Avertismente: niciunul.")
    for p in probleme:
        print(f"  - {p}")


def main(argv):
    if len(argv) < 3 or argv[1] not in {"titlu", "descriere", "infografic"}:
        print(__doc__)
        return 1
    mod = argv[1]
    if mod == "titlu":
        for t in argv[2:]:
            verifica_titlu(t)
            print()
    elif mod == "descriere":
        text = sys.stdin.read() if argv[2] == "-" else Path(argv[2]).read_text(encoding="utf-8")
        verifica_descriere(text)
    else:
        verifica_infografic(argv[2], argv[3:])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
