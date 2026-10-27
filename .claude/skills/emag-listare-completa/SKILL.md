---
name: emag-listare-completa
description: >-
  Fluxul complet, în 8 pași, pentru listarea perfectă a unui produs eMAG pornind de la un cod
  (PNK, cod_produs, EAN, offer id sau id din DB): reamintiri din memorie, date doar din DB,
  research pe emag.ro, căutare după imagine pe Alibaba + pozele furnizorului la rezoluție maximă,
  titlu/descriere (RO, HU, BG)/caracteristici verificate (textele le pune utilizatorul în Base, nu se salvează în aplicație), galerie de 8 poze 2000×2000
  în stil Amazon (Playfair + Montserrat, discret), clare la 100%, pe RO/HU/BG plus setul EN (doar în aplicație), iar la final întrebarea dacă trimite pozele în Base (fără răspuns, nu trimite nimic). Folosește-l când utilizatorul
  scrie „Produs: <COD>”, „listarea perfectă pentru <COD>”, „fă listarea completă”,
  „/emag-listare-completa <COD>” sau dă un cod de produs și cere listare/relistare cu poze pe limbi.
---

# Listare completă eMAG pentru un produs

Argument: `<COD_PRODUS>` (PNK, cod_produs, EAN, offer id sau id din DB). Dacă lipsește, cere-l.

Regulile de conținut (zone de titlu, roluri de poze, mărimi de font, descriere) sunt în skill-ul
**emag-listare-perfecta**: încarcă-l primul (`Skill emag-listare-perfecta`) și urmează-l. Skill-ul de față
adaugă ordinea pașilor, sursele de date, uneltele și regulile de siguranță.

**Regulă generală: NU publica nimic (în Base sau pe eMAG) fără ca utilizatorul să spună explicit „trimite pe eMAG” / „trimite în Base”
(pentru acel produs și acea acțiune). „Salvează” înseamnă doar în aplicație (DB local).**
Citirile din API-ul eMAG (product_offer/read, category/read) sunt permise. Din 2026-10-26 scrierile directe pe eMAG/Trendyol sunt blocate în aplicație: totul pleacă prin Base (pasul 7).
La finalul listării (pasul 8) **întrebi tu** dacă să trimiți pe eMAG. Un „Da” la acea întrebare ține loc de „trimite pe eMAG”, dar doar pentru produsul respectiv și doar pentru ce a ales utilizatorul.

Citește [`references/lectii.md`](references/lectii.md) înainte de pașii 1, 3 și 6: conține capcanele deja întâlnite.

Scripturile sunt în `.claude/skills/emag-listare-completa/scripts/` (prescurtat mai jos `$SK`).
Lucrează într-un director al produsului în scratchpad (ex. `<scratchpad>/<cod>/`) și pune acolo tot ce descarci sau generezi; la final se șterge (vezi „Curățenie” la pasul 8).

Dă-i utilizatorului câte un mesaj scurt de progres la fiecare pas: research-ul și generarea pozelor durează.

## 0. Reamintiri
La început, spune-i utilizatorului ce e în memorie (MEMORY.md și fișierele legate) despre problemele eMAG nerezolvate.

**Listări neterminate.** Citește tabelul din memorie `/home/gxg/.claude/projects/-home-gxg-2-aplicatie-emag/memory/listari-neterminate.md`: are câte un rând pentru fiecare produs rămas la jumătate (ce mai e de făcut, ce așteaptă, unde sunt fișierele).
- Spune-i utilizatorului pe scurt câte produse sunt deschise și care așteaptă doar o acțiune a lui (preț, ofertă nouă, poze reale).
- Dacă produsul cerut acum e în tabel, **continuă de unde a rămas**, nu reface listarea de la zero. Citește fișierul lui de memorie (coloana „Detalii”) și fișierele din `.claude/tmp-listare/<cod>/`, apoi verifică starea reală (pagina „Pregătire Base” sau `buildPayload` de la pasul 7, plus `product_offer/read` pe eMAG) înainte să acționezi. Coada (`emag-queue`) nu mai există din 2026-10-27.

## 1. Date din DB
- Rulează `.claude/skills/emag-listare-perfecta/scripts/produs_din_db.sh <COD_PRODUS>`. Datele vin DOAR din DB (`catalog_products`), nu din Excel-urile din FISIERE.
- Citește și oferta de pe eMAG (doar citire), pentru că pe eMAG pot fi mai multe caracteristici decât în copia locală:
  `docker cp $SK/emag_oferta_citeste.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/emag_oferta_citeste.js <offer_id>`
- Semnalează ce e greșit: descriere șablon de la alt produs, caracteristici incomplete (mai ales „Destinat pentru” și alte filtre), poze puține sau doar pe platforma `en`, poze cu watermark (de ex. „DERMAY” repetat pe diagonală), variante din familie cu nume sau culori greșite.
- `nr_bucati` și dimensiunile din DB: vezi lecțiile. Nu le modifica.
- Dacă nu există link de furnizor, întreabă. Nu inventa specificații.

## 2. Research pe eMAG (WebFetch)
- Pagina produsului (`https://www.emag.ro/search/<PNK>` sau linkul direct): preț, recenzii, specificații, variante.
- Căutări pe keyword-urile principale: titlurile și prețurile concurenților, filtrele din stânga.
- Recenziile de 1–3★ la concurenții direcți (ca să găsești fricile) și întrebările clienților.
- Din toate astea scoți: cum caută, ce compară, ce frici au, de ce cumpără, persona.
- Completezi și partea de client din `emag-listare-perfecta` (pasul 1b): rezultatul dorit, momentul declanșator, alternativele (inclusiv „nu face nimic” și improvizația), fricile pe cele 6 riscuri și limita cinstită. Tabelele sunt la finalul `.claude/skills/emag-listare-perfecta/references/checklist.md`.

## 3. Conținutul setului, specificații și poze de la furnizor

### 3a. Căutare după imagine pe Alibaba (de făcut întotdeauna)
Metoda e testată pe 2026-10-03. Folosește Claude in Chrome: încarcă instrumentele cu un singur ToolSearch, inclusiv `file_upload`, `find`, `javascript_tool` și `browser_batch`, și lucrează într-un tab nou.
1. Pregătește poza principală a produsului (pe alb, ≤800px, JPG) **în directorul de lucru al proiectului**, de exemplu `.claude/tmp-imgsearch/query.jpg`. `file_upload` nu citește din scratchpad.
2. Deschide `https://www.alibaba.com/`. Cu `find`, caută „Image search button” și dă click pe el. Apoi, din nou cu `find`, caută „file input with class upload-file” (`input.upload-file`, accept image/*). Nu da click pe câmpul de fișier: s-ar deschide fereastra nativă de selecție.
3. Încarcă poza pe câmp cu `file_upload(ref, paths=[...])`, așteaptă ~4 s și verifică că URL-ul conține `/search/page?...SearchScene=imageTextSearch`.
4. Rulează `$SK/alibaba_rezultate.js` cu `javascript_tool` (conținutul fișierului ca text). Primești id-urile, linkurile și titlurile. Alege 2–4 produse care sunt **același model**: aceeași formă și aceleași culori ca la noi.
5. Șterge `.claude/tmp-imgsearch/` la final.

Pentru numele aromei sau al culorii la alți vânzători mai poți încerca Google Lens: `https://lens.google.com/uploadbyurl?url=<URL public al pozei de pe eMAG>`.

### 3b. Pagina produsului Alibaba (și linkurile date de utilizator)
WebFetch e blocat pe Alibaba, așa că folosește Chrome:
- pe pagina produsului rulează `$SK/alibaba_imagini.js`, care întoarce galeria (thumbnail-urile din stânga), pozele culorilor, descrierea inline, „Key attributes” și variantele (Color, Fragrance);
- apoi deschide `https://www.alibaba.com/product-detail/description/descIframe.html?productId=<ID>` și rulează `$SK/alibaba_descriere.js`. De aici iei pozele de descriere și textul cu lista exactă a pieselor, dimensiunile, materialul și aroma pe culori. Citește tot textul cu `get_page_text`.

### 3c. Descărcare la rezoluție maximă
Salvează JSON-ul de la 3b într-un fișier și rulează:
```bash
python3 $SK/descarca_imagini.py <dir>/aliA a --json aliA.json
python3 $SK/descarca_imagini.py <dir>/aliA a URL1 URL2 ...
```
Prima formă ia URL-urile din JSON, a doua le primește direct. Scriptul:
- scoate sufixele de miniatură (`_960x960q80.jpg`, `_100x100.jpg`, `_.webp`) ca să ia originalul;
- sare peste duplicate și păstrează varianta cea mai mare;
- scrie `<dir>_sheet.jpg` (nume + rezoluție) și `_index.json`.

Merge și pentru AliExpress (`ae01.alicdn.com`).
- Uită-te la contact sheet și **filtrează**: pagina conține și recomandări (alte produse), alte culori și poze cu obiecte care nu sunt în pachet. Elimină și pozele cu watermark (numele altui vânzător sau al unei mărci, de obicei semitransparent și repetat): caută aceeași poză curată la alt furnizor.
- Raportează rezoluția: pozele Alibaba au adesea doar 750–800px, deci vor fi mărite cu `upsharp`.
- Verifică dimensiunile de pe poze față de text și între surse. Dacă se contrazic, arată-i utilizatorului un tabel cu sursa fiecărei valori și nu alege singur în tăcere.
- Ce arată alt vânzător în pachet (sticluță, inel de lemn) nu e automat pachetul nostru: întreabă.

## 4. Titlu, descriere și caracteristici
- **Titlu:** 80–100 de caractere, **maximum 100** (același titlu merge pe Trendyol, care respinge peste 100), iar zona A (primele 50) trebuie să se înțeleagă singură pe telefon. Verifică-l cu `python3 .claude/skills/emag-listare-perfecta/scripts/verifica_listare.py titlu "..."`.
- **Descriere:** 200–350 de cuvinte, verificată cu `verifica_listare.py descriere - <<'EOF' ... EOF` sau `verifica_listare.py descriere fisier.txt`.
  - Fără bold markdown (`**`): aplicația transformă textul în HTML cu `<p>`, iar asteriscurile ar apărea literal pe eMAG.
  - Fără diacritice în titlu și descriere, pentru consecvență cu catalogul.
  - Bullets cu „- ” la început de rând.
  - Variantele dintr-o familie au același text; diferă doar culoarea sau mărimea.
- **Limbaj standard, nu regional** (titlu, descriere, caracteristici și textele de pe poze, în RO, HU și BG): folosește limba literară, înțeleasă la fel în toată țara, și termenul cu care se caută produsul pe eMAG.
  - RO: fără regionalisme sau cuvinte de zonă (de ex. „pită”, „cucuruz”, „crumpene”, „șpais”, „ciubăr” în loc de „pâine”, „porumb”, „cartofi”, „cămară”, „cadă”), fără argou și fără termeni de atelier/jargon local; dacă un termen are o variantă regională și una standard, alege-o pe cea din DEX/folosită în titlurile concurenților.
  - HU: maghiară standard (cea de pe emag.hu), nu regionalisme din Ardeal sau traduceri calchiate după română.
  - BG: bulgară literară, nu dialectală; termenul folosit pe emag.bg.
  - La dubiu, verifică termenul cu o căutare pe emag.ro/.hu/.bg: dacă dă puține rezultate față de sinonim, e probabil regional.
- **Caracteristici:** propune valori DOAR din lista permisă a categoriei. Lista o iei doar citind, cu:
  `docker cp $SK/emag_categorie.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/emag_categorie.js <category_id> && docker cp emag-back:/tmp/categorie_<category_id>.json <dir>/`
  - Capcană: în categoria 116 valoarea e „Geamuri auto”, nu „Geamuri”.
  - Caracteristicile multi-valoare se trimit ca mai multe intrări cu același id.
  - Când `allow_new_value=1`, poți scrie o valoare nouă.
  - O valoare care nu poate fi dovedită se marchează și se cere utilizatorului.
- **Titlu și descriere în HU și BG** (de făcut întotdeauna, nu doar pe RO):
  - Citește ce e acum pe eMAG HU/BG: `trimite_texte.js` fără `send` (doar citire; scrierea directă e blocată) arată titlul și descrierea actuale. Des, descrierea lipsește sau titlul e o traducere automată cu `cod_produs` în față.
  - Nu traduce cuvânt cu cuvânt: pornește de la textul RO aprobat și adaptează keyword-urile la cum se caută pe emag.hu / emag.bg (verifică 1–2 căutări cu WebFetch). Aceleași reguli de lungime: titlu 80–100 de caractere, maximum 100, zona A înțeleasă singură; descriere 200–350 de cuvinte, bullets cu „- ”, fără `**`.
  - Spre deosebire de RO, aici **păstrezi diacriticele**: maghiara fără á, é, ő, ű e greu de citit, iar BG e în chirilică. Unitățile: „cm” în HU, „см” în BG.
  - Aceleași fapte ca pe RO (dimensiuni, conținutul pachetului, culoare): nimic în plus.
  - Scrie-le în `<dir>/texte_hu_bg.json` (`{"hu": {"name", "description"}, "bg": {...}}`) și verifică titlurile cu `verifica_listare.py titlu`.
- Înainte să arăți textele, treci prin `.claude/skills/emag-listare-perfecta/references/checklist.md` (titlu, descriere și caracteristici, verificarea finală). Pentru pozele de la pasul 6 folosește secțiunea de poze din același fișier.
- **Arată-i utilizatorului totul înainte de salvare**, într-un tabel înainte/după (RO, HU și BG), plus întrebările deschise. Pune acolo și ce lipsește din regulile legale (date GPSR: producător, persoana responsabilă din UE, avertismente).

## 5. Salvare în aplicație (doar local, după confirmare)
- **Titlul și descrierea NU se mai salvează în aplicație** (din 2026-10-27): utilizatorul le editează direct în Base, iar aplicația nu le mai arată și nu le mai trimite pentru produsele deja în Base. Nu scrie în `catalog_products.nume`/`descriere` și nici în `product_texts` (name/description).
  - Pune textele finale RO/HU/BG în `.claude/tmp-listare/<cod>/texte.md` (titlu + descriere pe fiecare limbă, gata de copiat) și dă-le întregi în rezumat, ca utilizatorul să le pună în Base.
- Fă întâi backup cu valorile vechi ale caracteristicilor (JSON în scratchpad).
- Caracteristicile sunt doar o copie locală text:
  `UPDATE marketplace_listings SET characteristics = '<id>: valoare; ...' WHERE product_id=<id> AND channel='emag'`
  Valorile multiple se despart prin virgulă. Rulează-l prin `docker exec emag-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" ...'`.
- Recitește din DB și confirmă ce s-a salvat.

## 6. Poze pe limbi (RO, HU, BG + EN): 8 poze de 2000×2000
- Pornește de la pozele furnizorului: cele deja încărcate (tabela `product_images`, fișierele în `/var/www/poze/_catalog/<stored_name>` sau în MinIO) plus cele noi de la pasul 3. Alege pentru fiecare rol poza cu cea mai mare rezoluție.
- Galeria-tip, adaptată la produs:
  1. principala pe alb, fără text și fără obiecte care nu sunt în pachet (scoate-le cu PIL, pixel cu pixel, păstrând marginile produsului);
  2. produsul în folosire (dorință);
  3. dimensiuni în cm, cu cotele originale în inch acoperite cu alb și rescrise. Dacă nu există o poză cu cote, desenează-le pe decupaj;
  4. detalii / colțuri;
  5. calitate sau înainte/după;
  6. „X piese într-o cutie”, cu cifre centrate în cercuri: centrează după textbbox, nu după vârful textului, și folosește font mai mic pentru numerele de 2 cifre (`g_pieces`);
  7. pozele furnizorului cu etichetele traduse, sau „Cum funcționează”;
  8. „Unde îl folosești” / „Pentru cine este”.
- Scoate pozele care promit ceva ce nu e în set și textele promoționale. Acoperă TOT textul în engleză de pe pozele furnizorului și logo-urile vânzătorilor (textul englezesc al galeriei EN îl scrii tu, pe fundal curat).
- **Conținutul pozelor** (din checklistul de poze, `.claude/skills/emag-listare-perfecta/references/checklist.md`, secțiunile C–G):
  - principala: alb pur (255, 255, 255), verificat pe pixelii din colțuri și de lângă produs; produsul întreg, centrat, ~85% din cadru; o singură vedere (nu față și spate împreună); doar varianta livrată și accesoriile din cutie;
  - fiecare poză răspunde la altă întrebare; nicio poză nu o repetă pe alta;
  - poza de pachet: fiecare piesă numerotată și etichetată;
  - cosmetice: textura de aproape, folosirea în 3 pași, ingredientele-cheie; electronice: cifrele mari (autonomie, putere), conectivitatea, butoanele, compatibilitatea;
  - beneficii concrete cu cifre („42 de ore de muzică”, nu „baterie 400 mAh”); o singură limbă pe poză; unitățile pieței (cm, kg, ml; „см” în BG); ortografia verificată de două ori;
  - culoarea produsului rămâne cea reală: nu schimba nuanța pozelor furnizorului; compar-o cu poza variantei din aplicație.
- **Interzis pe orice poză:** stele de rating, citate din recenzii, „livrare gratuită”, insigne de platformă sau imitații ale lor, logo-uri sau produse ale concurenței, cifre comparative fără dovadă („10X”, „-44%”, „#1”), afirmații ecologice generice („eco”, „biodegradabil”, „prietenos cu mediul”; interzise în UE din 27.09.2026), promisiuni medicale, iar la cosmetice „fără parabeni” sau „fără conservanți”. Logo-urile de certificare de pe pozele furnizorului (CE, FDA, RoHS, BIO, OEKO-TEX) se scot dacă nu avem documentul; dacă nu se pot scoate curat, alege altă poză.
- **Niciun watermark pe niciuna dintre cele 8 poze.** eMAG respinge pozele cu watermark, iar o poză marcată de alt vânzător e a lui, deci folosirea ei poate închide listarea. Nu șterge watermark-ul altcuiva din poză, nici cu PIL: înlocuiește poza cu una curată de la furnizor. Dacă nu există alta, spune-i utilizatorului ce rol rămâne fără poză.
- **Stil (aprobat de utilizator: profesionist, ca pe Amazon, discret, nimic prea bold):**
  - Două fonturi, nu mai multe, ambele în skill (`fonts/`, licență OFL, cu ș/ț, ő/ű și chirilică):
    - **titluri** în Playfair Display **SemiBold**, MAJUSCULE, litere ușor spațiate. Pe bandă închisă (#16181E) sunt aurii, în degradeu, cu o linie fină și un romb dedesubt (`head()`); pe crem sunt în culoarea cernelii (`head(..., dark=False)`);
    - **restul textului** în Montserrat **Medium** (`font(size)`). **SemiBold** (`font(size, extra=True)`) doar pentru pastile, cifre și etichete scurte.
  - **Interzis:** Bold, ExtraBold, Black, OpenSans/Arial, contur sau umbră pe text, text înclinat, mai mult de 3 mărimi de text pe o poză, MAJUSCULE în afara titlului, culori stridente (roșu, verde neon), săgeți și stickere „PROMO”.
  - Paleta: cerneală #16181E, crem #F6F2EA, auriu #C8983A, gri cald pentru textul secundar, alb. Principala rămâne pe alb pur. Paleta e fixă (kitul aprobat) și nu se schimbă de la un produs la altul.
  - **Contrast** (minim 4,5:1 pentru text mic, 3:1 pentru titluri). Măsurat pe paletă: auriu pe cerneală 6,8:1, cerneală pe crem 15,9:1, gri cald (`GREY`) pe crem 4,7:1 și pe alb 5,2:1, deci toate trec. **Auriul pe alb sau crem are doar 2,4–2,6:1**: pe fundal deschis auriul se folosește doar pentru linii, contururi, ornamente și pastile cu text de cerneală (`gold_pill`), niciodată pentru text. Niciun text mai deschis decât `GREY` pe fundal deschis.
  - Mult spațiu liber: margine de 100–120px (5–6%), o singură idee pe poză, textul pe fundal, niciodată peste produs. Text peste fotografie doar în zone liniștite sau pe bandă închisă (`dark_top`).
  - Spațiere între rânduri de 115–130% din mărimea fontului.
  - Pozele reale ale variantei exacte; nu folosi același decupaj alb pe mai mult de 2 poze.
- **Rezoluție (fiecare poză trebuie să fie clară la 100%):**
  - Pentru fiecare rol alege sursa cea mai mare (pasul 3c). Toate pozele intră în galerie DOAR prin `photo(im, w=..., rol="...")`. Funcția micșorează sau mărește cu LANCZOS, aplică un sharpen dozat după factor, notează factorul și **oprește scriptul peste 2×**.
  - Între 1,5× și 2× poza apare cu ⚠ în raport: verific-o în crop-ul 1:1. Peste 2× NU mări: caută o sursă mai mare (alt furnizor Alibaba/AliExpress, originalul fără sufix de miniatură) sau pune poza într-un cadru mai mic (cel mult 2× lățimea sursei, pe fundal crem sau închis). `max_up` mai mare se folosește doar cu acordul utilizatorului.
  - Nu decupa o zonă mică pentru a o umfla pe toată lățimea; un detaliu se ia dintr-o poză de ≥1000px.
  - `load()` deschide pozele cu rotirea EXIF aplicată și cu conversie în sRGB. Pașii intermediari se salvează în PNG, nu în JPG peste JPG.
  - Cercurile, pastilele, liniile oblice și ornamentele se desenează cu `aa_shape` / `aa_line` / `aa_polygon`, adică netezite (randate la 4× și micșorate). `ImageDraw.ellipse`/`rounded_rectangle` lasă margini zimțate.
  - `save_all` scrie JPG la calitate 95, 4:4:4, progresiv, sub 5,5 MB. Pe lângă contact sheet scrie `sheet_<lang>_1la1.jpg` (zona titlului și centrul fiecărei poze la 100%) și afișează raportul cu factorii de mărire.
- **Tehnic:**
  - Python + PIL (nu există numpy/cv2). Helperii sunt în `$SK/galerie_common.py`. Exemplul complet, cu stilul aprobat (56 PARF-SOL-AURIU), e în `$SK/build_lang_exemplu.py` și `$SK/texte_exemplu.json`: copiază-l și adaptează-l.
  - Fonturile se iau automat din `.claude/skills/emag-listare-completa/fonts/`; nu le copia.
  - Un singur script `build_lang.py <lang>` care citește textele din `texte.json` (`{ro, hu, bg, en}`). Unitatea „cm” devine „см” în BG.
  - **Galeria EN (obligatorie, cerută de utilizator pe 2026-10-25):** aceleași 8 poze ca RO, cu textele în engleză, construite cu același `build_lang.py en` (cheia `en` în `texte.json`). Se urcă în aplicație pe platforma `en` (`product_images.platform='en'`) și **nu se trimite pe eMAG**. În engleză zecimalele se scriu cu punct (6.7 cm, nu 6,7 cm), iar textul e engleză simplă, nu traducere cuvânt cu cuvânt. Ori de câte ori se schimbă galeria RO, refă și EN; altfel EN rămâne pe versiunea veche.
  - Mărimi: titlu 120–132px (implicit 132; dacă nu încape la 120, scurtează textul), text explicativ 76–88px, text secundar ≥60px, ≤20 de cuvinte pe imagine.
  - Verifică fiecare set de texte cu `verifica_listare.py infografic "titlu" "eticheta" ...`.
  - Uită-te la fiecare poză (contact sheet, `_1la1.jpg` și crop la ~700px pe zonele reparate) și repară: text care se suprapune, iese din cadru sau atinge produsul, linii de cotă șterse, resturi de text în engleză, zone moi sau pixelate, margini zimțate și halou alb în jurul decupajului.
  - Fă și cele două teste de lizibilitate: fiecare poză micșorată la 375px lățime (titlul se citește fără zoom) și la ~180px (mesajul se înțelege într-o secundă). Miniaturile din contact sheet au 500px, deci micșorează separat, în afara lui `out/` (care urcă în aplicație): `mkdir -p <dir>/test && python3 -c 'import sys,os;from PIL import Image;[Image.open(f).resize((s,s),Image.LANCZOS).save(f"{sys.argv[1]}/{s}_{os.path.basename(f)[:-4]}.png") for f in sys.argv[2:] for s in (375,180)]' <dir>/test <dir>/out/*.jpg`.
  - Arată-i utilizatorului întâi contact sheet-ul RO și construiește HU/BG/EN doar după ce îl aprobă.
  - Pe poze folosește diacritice corecte (ș, ț cu virgulă).
- **Încărcare în aplicație** (doar local), cu `docker cp out emag-back:/tmp/p<id>`, apoi:
  - galerie nouă: `docker exec -w /app emag-back node /tmp/imagini_app.js add <id> <cod_produs> /tmp/p<id>`;
  - setul EN: dacă `out/en/` există, `add` și `replace` îl înlocuiesc întreg (pozele en vechi pot avea alte nume, de ex. `MAMP1.jpg`); fără `out/en/` setul en rămâne neatins;
  - înlocuirea unor poze: `... imagini_app.js replace <id> <cod_produs> /tmp/p<id> 4,5,8` (face deleteImage, addImages și reorder);
  - verificare: `... imagini_app.js list <id> - -`.

  Copiază întâi scriptul cu `docker cp $SK/imagini_app.js emag-back:/tmp/`. Compară apoi `byte_size` din DB cu fișierele generate.
- Trimite-i utilizatorului contact sheet-ul fiecărei limbi cu SendUserFile.

## 7. Trimitere în Base (DOAR după „trimite pe eMAG” / „trimite în Base” sau după „Da” la întrebarea de la pasul 8)
Din 2026-10-26 nimic nu pleacă direct pe eMAG: aplicația blochează scrierile (`direct-writes.js`), iar scripturile vechi `trimite_*.js` nu mai merg pentru scriere. Un singur push trimite în Base tot produsul: SKU, EAN, greutate/dimensiuni, prețul, galeria RO ca galerie implicită și galerii proprii pe eMAG HU/BG. Base le publică apoi pe eMAG RO/HU/BG și Trendyol. Stocul nu pleacă, îl ține Base. Titlul și descrierea pleacă doar când produsul se creează în Base; la produsele existente rămân cele editate de utilizator în Base.
**Totul pleacă prin API. Nu deschide browserul în portalul Marketplace ca să urci poze sau să editezi produsul.** Pozele stau în Cloudflare R2 (`https://poze.hostera24.com/products/...`).
- **Dry-run (obligatoriu, arată-i utilizatorului rezultatul):**
  `docker exec -w /app emag-back node -e 'require("./base-push").buildPayload(<id>).then(p=>{console.log(JSON.stringify({warnings:p.warnings,image_sources:p.image_sources,changed:p.changed,texts:Object.keys(p.payload.text_fields),images:Object.keys(p.payload.images).length},null,1));process.exit(0)})'`
  Rezolvă întâi `warnings` (poze, brand, preț).
- **Trimitere:** butonul din pagina „Pregătire Base” (`/base.html?id=<id>`) sau
  `docker exec -w /app emag-back node -e 'require("./base-push").pushProductToBase(<id>).then(r=>{console.log(r.dry_run,r.base_product_id,r.created);process.exit(0)})'`.
  Dacă iese `dry_run: true`, `BASE_SEND=1` lipsește din `.env`: spune-i utilizatorului, nu ocoli.
- **Verificare:** după câteva minute, citește oferta pe eMAG pe fiecare platformă (`emag_oferta_citeste.js`, doar citire) și compară numărul de poze (titlul și descrierea doar după ce utilizatorul le-a pus în Base). Sincronizarea Base → eMAG poate dura; dacă nu s-a schimbat, verifică în Base, nu retrimite în buclă.
- Caracteristicile eMAG: `product_texts.characteristics` (obiect `{nume: valoare}`) pleacă în Base ca `features`; maparea pe caracteristicile eMAG o face integrarea Base.
- „Invalid vendor ip” la citirile HU/BG înseamnă că IP-ul serverului trebuie adăugat în contul eMAG HU/BG.

## 8. La final

### Întrebarea de trimitere în Base (obligatorie)
După ce totul e salvat local, iar pozele sunt în aplicație pe RO, HU, BG și EN, **întreabă-l pe utilizator cu AskUserQuestion** dacă să trimiți în Base (de acolo pe eMAG) pozele. Întreabă și când pare evident, și nu trimite nimic înainte de răspuns.
- În întrebare spune ce ar pleca, pe fiecare platformă (RO, HU, BG): cele 8 poze, prețul și dimensiunile, dacă s-au schimbat. Amintește că titlul și descrierea le pune el în Base (din `texte.md`).
- Opțiuni (multiSelect: false):
  - „Da, trimite în Base (Recommended)”: un singur push, pleacă toate galeriile;
  - „Nu acum”, adică totul rămâne doar local.
- La „Da”, mergi la pasul 7: întâi dry-run-ul (`buildPayload`), apoi trimiterea, dacă nu are `warnings` de rezolvat.
- La „Nu acum”, scrie în rezumat ce a rămas netrimis.

### Rezumat
Un rezumat scurt:
- ce e salvat local, ce e pe eMAG și pe ce platforme, plus titlul și descrierea RO/HU/BG întregi, de pus în Base;
- ce a rămas deschis: câmpuri suspecte din DB, valori nedovedite (aromă, conținutul pachetului), poze care ar trebui făcute real (de ex. înainte/după, produsul în mașină), conflicte de dimensiuni. Pentru pozele de făcut real, dă lista exactă de cadre (frontal, 3/4, lateral, spate, de sus, detaliu de aproape, în mână, în folosire, ambalaj, conținutul pachetului) și trimite la setup-ul din checklistul de poze, secțiunea B.

Actualizează memoria dacă s-a rezolvat sau a apărut o problemă eMAG de reamintit.

### Listări neterminate (obligatoriu, la fiecare final de sesiune)
Actualizează tabelul `/home/gxg/.claude/projects/-home-gxg-2-aplicatie-emag/memory/listari-neterminate.md`, chiar dacă sesiunea s-a oprit la jumătatea pașilor:
- **dacă a rămas ceva de făcut** (o platformă netrimisă sau în coadă, oferta HU/BG lipsă, preț respins, poze neaprobate, date de cerut, GPSR), adaugă sau actualizează rândul produsului:
  - `id cod_produs`;
  - ce mai e de făcut, concret: pasul și platforma, de exemplu „HU #76 → BG #77” sau „poze HU/BG neconstruite”;
  - ce așteaptă (validare, răspunsul utilizatorului, preț);
  - unde sunt fișierele, de regulă `.claude/tmp-listare/<cod>/`;
  - data de azi;
  - linkul `[[...]]` spre fișierul de memorie al produsului.
- **dacă produsul e terminat** (RO, HU și BG validate, status 9 fără erori, nimic deschis), șterge rândul.
- Tot ce trebuie pentru reluare (textele HU/BG, `build_lang.py`, `texte.json`, backup-ul, sheet-urile, json-ul de coadă) se copiază în `.claude/tmp-listare/<cod>/` **înainte** de curățenia scratchpad-ului, pentru că scratchpad-ul se șterge.
- Spune-i utilizatorului în rezumat că produsul a rămas în lista de neterminate și de ce.

### Curățenie (obligatoriu, la sfârșitul listării)
Pozele finale sunt deja în aplicație (`product_images` + stocare), deci tot ce e pe disk sunt copii sau candidați (~20–45 MB pe produs). Șterge-le când utilizatorul nu mai cere modificări la poze și `imagini_app.js list` arată 8 poze pe ro/hu/bg/en cu `byte_size` egal cu fișierele generate:
- directorul produsului din scratchpad, cu tot ce conține (poze Alibaba, `desc/`, `img/`, `out/`, contact sheet-uri, ciorne, fonturi): `rm -rf <scratchpad>/<cod>`;
- tot ce ai copiat în container pentru acest produs: `docker exec emag-back sh -c 'cd /tmp && rm -rf p<id> n<id> descriere<id>.txt schimbari.json texte_hu_bg.json categorie_*.json alibaba_*.js emag_*.js imagini_app.js trimite_*.js'`;
- `.claude/tmp-imgsearch/`, dacă a rămas.

Textele nu stau în aplicație: înainte să ștergi directorul, verifică că `texte.md` e copiat în `.claude/tmp-listare/<cod>/` și că textele sunt întregi în rezumat.

Nu șterge nimic din `/var/www/poze/`, din stocarea aplicației sau din `/tmp/node-compile-cache` din container. Spune-i utilizatorului în rezumat că ai făcut curățenia.
