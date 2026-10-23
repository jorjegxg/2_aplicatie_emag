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
- Pe 2026-10-19 paginile de produs Alibaba (și `descIframe.html`) cereau CAPTCHA cu slider, chiar și prin curl, iar căutarea după imagine mergea. Originalul pozei principale se ia de pe CDN din cardul de rezultat: `kf/<id>.jpg` din `img.src`, fără sufixul `_300x300`, e 800–1000px. AliExpress (`/item/<id>.html`) prin curl are în HTML `imagePathList` cu galeria la 930px.
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
- „Publică” din aplicație trimite doar preț/stoc/titlu/descriere, și doar pe RO. Caracteristicile, pozele și titlul/descrierea HU/BG pleacă doar prin `trimite_caracteristici.js`, `trimite_poze.js` și `trimite_texte.js`, și doar după „trimite pe eMAG”.
- Titlu/descriere HU/BG (`trimite_texte.js`): eMAG întoarce descrierea cu entități HTML (`&eacute;`, `&#337;`, `&Oslash;`). Scriptul le decodează înainte de comparare; fără asta, recitirea dă „DIFERITĂ” deși textul e corect.
- `UPDATE_NOT_ALLOWED_DIFFERENT_PLATFORM` în `validation_status[0].errors`: produsul are deja o actualizare de documentație în validare pe altă platformă (de ex. RO cu status 11 „Documentation update validation pending”). Save-ul pe HU/BG întoarce 200 și recitirea arată textul nou, dar eMAG îl respinge. Trimite HU/BG după ce RO ajunge la status 9, sau înainte de „Publică” pe RO.
- Regula e valabilă între ORICARE platforme, nu doar față de RO: pe 2026-10-03, la 56, textul HU a fost respins pentru că BG era în validare. Pe produs poate fi în validare o singură platformă. Pune tot ce trebuie pe o platformă (titlu, descriere, caracteristici, poze cu `images_overwrite: 1`) într-un singur `product_offer/save`. Trece la platforma următoare doar după ce toate platformele produsului au status 9. Produse diferite pot merge în paralel.
- `/tmp` din containerul `emag-back` e comun pentru toate sesiunile care lucrează în paralel. Pe 2026-10-13 o altă sesiune a suprascris `trimite_platforma.js` și `texte_toate.json` între dry-run și send. Copiază fișierele în container cu prefixul produsului (`/tmp/p12_trimite.js`, `/tmp/p12_texte.json`, `/tmp/p12_schimbari.json`) și verifică md5 înainte de `send`. La curățenie șterge doar fișierele tale, nu `trimite_*.js` sau `schimbari.json` generice.
- Pe 2026-10-13 o altă sesiune a șters `/tmp/trimite_*.js` din container în timpul listării SUP-MAG (curățenia ei). Copiază scripturile și datele în container cu prefixul produsului (`/tmp/p<id>_trimite.js`, `/tmp/p<id>_texte.json`) și șterge doar ce are prefixul tău.
- `validation_status = 9`, citit imediat după un save, NU înseamnă că platforma a terminat. Pe 2026-10-13, la 12, RO a fost trimis la 14:59 și raporta 9. HU, trimis la 15:04, a primit totuși `UPDATE_NOT_ALLOWED_DIFFERENT_PLATFORM` („update already in progress on emag-ro”), deși recitirea arăta titlul, descrierea și pozele noi. Între platforme lasă cel puțin 20 de minute, nu 5, și verifică la final lista `errors`, nu doar `value`.
- Semnalul că RO a terminat de procesat o actualizare: pe HU/BG apar, traduse automat, caracteristicile noi de pe RO. Cât timp HU/BG au încă setul vechi, RO e „in progress”, chiar dacă raportează 9 fără erori. O retrimitere HU făcută atunci a readus pe HU titlul vechi.
- Statusul 11 NU apare imediat. Pe 2026-10-13, la 14 (ORG-BANC-BEJ), RO a arătat status 9 aproape 3 ore după save, apoi a trecut în 11. HU, trimis la 10 minute după RO pe baza statusului 9, a fost respins (UPDATE_NOT_ALLOWED_DIFFERENT_PLATFORM). Nu te baza pe „toate sunt 9” imediat după un save. Trimite platforma următoare doar după ce ai văzut-o pe cea anterioară trecând 11 → 9, sau după câteva ore cu 9 și fără erori. După fiecare save, verifică și `validation_status[0].errors` pe platforma trimisă: dacă apare REJ, nu retrimite în buclă la 10 minute.
- Verifică `ownership` la pasul 1 (în `product_offer/read`), înainte de research și poze. Pe 2026-10-19, la 37 ORG-PORT (PNK DPG64B3BM), `ownership` era `false`: documentația era a altui vânzător (3 oferte, noi pe locul 3 la buy button, cea mai bună ofertă 18,95 lei față de 51,99 lei la noi). Fără ownership, eMAG nu ia de la noi titlu, descriere, poze sau caracteristici. Listarea se poate face local, dar trimiterea e blocată. Spune-i utilizatorului de la început și întreabă dacă merită continuat.
