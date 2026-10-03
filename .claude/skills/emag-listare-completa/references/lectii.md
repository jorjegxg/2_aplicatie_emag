# Lecții din listările făcute (de citit înainte de pașii 1, 3 și 6)

## Date din DB
- `catalog_products.nr_bucati` = cantitatea comandată la furnizor (intră în calculator, `cost_comanda = nr_bucati × cost`). NU e numărul de piese din set. Nu-l semnala ca suspect și nu-l modifica; piesele din set merg doar în caracteristica „Numar bucati/set” (7727 la odorizante).
- `lungime/latime/inaltime` din DB intră în greutatea volumetrică din `backend/calculator.js`, deci sunt dimensiunile COLETULUI. Dimensiunile reale ale produsului (de pe pozele furnizorului) merg doar în descriere, poze și caracteristici. Nu suprascrie coloanele din DB fără cerere explicită.
- Copia locală `marketplace_listings.characteristics` poate fi mai veche decât ce e pe eMAG. Citește oferta cu `scripts/emag_oferta_citeste.js` (doar citire) înainte să propui caracteristici.
- `cod_produs` nu se redenumește (ex. PARF-SOL-NEGRU e argintiu): e legat de comenzi și de Excel. Corectezi doar titlul și culoarea.

## Furnizor / Alibaba
- AliExpress dă des „item unavailable in your location”. Treci la căutarea după imagine pe Alibaba (pasul 3a).
- Google Lens (`https://lens.google.com/uploadbyurl?url=<URL public al pozei>`) e util pentru numele aromei/culorii la alți vânzători. Exemplu: auriul se vindea ca „Tuhao Gold – Cologne”.
- Același model apare la mai mulți vânzători cu aceleași poze de descriere (fabrica e aceeași). Pozele de descriere au adesea fișa tehnică (dimensiuni, material, aromă pe culori) și pașii de montaj.
- Fișele se pot contrazice (ex. 10.5×7.5×5.3 vs 12×5×7.5 vs 10.5×8.6×6). Pune-le într-un tabel cu sursa și spune ce alegi și de ce (de regulă: ce confirmă două surse independente). Nu alege în tăcere.
- Ce arată pachetul la ALT vânzător (sticluță, inel de lemn, cutie retail) nu e neapărat pachetul nostru. Nu-l folosi în „Ce primești în cutie” fără confirmare.
- Nu folosi pozele/afirmațiile care nu se pot dovedi: „safe for pregnant and infants”, „-60°C…100°C”, „premium quality”, ursuleți/figurine/covorașe care nu sunt în pachet.
- Uneori o poză „nouă” e aceeași fotografie pe care o ai deja (ex. AR2 = aliA/g05). Compară vizual înainte s-o numeri ca nouă.

## Poze (PIL)
- Logo de vânzător pe un colț cu textură: NU-l acoperi cu un petic copiat (se vede dreptunghiul). Fă crop care îl scoate din cadru, apoi mărește la 2000.
- Text englezesc peste fundal închis: bandă de titlu închisă cu trecere lină (`dark_top(im, opaque_to, fade_to)`) peste toată lățimea. Umplerea rând cu rând dintr-o coloană-sursă lasă dungi sau un dreptunghi vizibil.
- Text englezesc pe fundal deschis: bandă albă cu trecere lină (`white_top`). Verifică ultimul rând de text (ex. „- No Cable/Battery Needed” a rămas vizibil de două ori).
- Cote în inch: pastile albe peste text (`pill_label`, `vpill` pentru cota verticală), cu valori în cm; în BG „см”. Pastila stă pe linia de cotă, nu o șterge.
- Fără poză cu dimensiuni pentru o variantă de culoare: desenează cotele pe decupajul pe alb (lungime totală, diametru bază măsurat automat pe rândul de la ~86% din înălțime, înălțime pe verticală).
- Decupaj de pe alb: flood-fill din colțuri pe masca >242 (`cutout`). Pozele Alibaba de 750–800px se măresc cu `upsharp` (LANCZOS + UnsharpMask ușor).
- Titlurile prea lungi în HU/BG nu încap la 120px: scurtează textul (ex. HU „Kicsi és diszkrét”, BG „Малък и дискретен”), nu micșora fontul.
- Uită-te la fiecare poză la ~700px după fiecare modificare (crop pe zona reparată), nu doar la contact sheet-ul mic.

## Aplicație / eMAG
- Scripturile rulate cu `node /tmp/x.js` rezolvă `require("./...")` față de /tmp: folosește căi absolute `/app/...` și `/app/node_modules/pg`.
- Clientul eMAG scrie loguri pe stdout („[auth] preferred ...”): nu parsa stdout ca JSON, scrie rezultatul într-un fișier.
- „Publică” din aplicație trimite doar preț/stoc/titlu/descriere. Caracteristicile și pozele pleacă doar prin `trimite_caracteristici.js` și `trimite_poze.js`, și doar după „trimite pe eMAG”.
