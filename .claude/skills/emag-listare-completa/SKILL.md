---
name: emag-listare-completa
description: >-
  Fluxul complet, în 8 pași, pentru listarea perfectă a unui produs eMAG pornind de la un cod
  (PNK, cod_produs, EAN, offer id sau id din DB): reamintiri din memorie, date doar din DB,
  research pe emag.ro, căutare după imagine pe Alibaba + pozele furnizorului la rezoluție maximă,
  titlu/descriere (RO, HU, BG)/caracteristici verificate, salvare DOAR locală, galerie de 8 poze 2000×2000
  pe RO/HU/BG și trimitere pe eMAG numai la „trimite pe eMAG”. Folosește-l când utilizatorul
  scrie „Produs: <COD>”, „listarea perfectă pentru <COD>”, „fă listarea completă”,
  „/emag-listare-completa <COD>” sau dă un cod de produs și cere listare/relistare cu poze pe limbi.
---

# Listare completă eMAG pentru un produs

Argument: `<COD_PRODUS>` (PNK, cod_produs, EAN, offer id sau id din DB). Dacă lipsește, cere-l.

Regulile de conținut (zone de titlu, roluri de poze, mărimi de font, descriere) sunt în skill-ul
**emag-listare-perfecta**: încarcă-l primul (`Skill emag-listare-perfecta`) și urmează-l. Skill-ul de față
adaugă ordinea pașilor, sursele de date, uneltele și regulile de siguranță.

**Regulă generală: NU publica nimic pe eMAG fără ca utilizatorul să spună explicit „trimite pe eMAG”
(pentru acel produs și acea acțiune). „Salvează” înseamnă doar în aplicație (DB local).**
Citirile din API (product_offer/read, category/read) sunt permise; scrierile nu.

Citește [`references/lectii.md`](references/lectii.md) înainte de pașii 1, 3 și 6: conține capcanele deja întâlnite.

Scripturile sunt în `.claude/skills/emag-listare-completa/scripts/` (prescurtat mai jos `$SK`).
Lucrează într-un director al produsului în scratchpad (ex. `<scratchpad>/<cod>/`) și pune acolo tot ce descarci sau generezi; la final se șterge (vezi „Curățenie” la pasul 8).

Dă-i utilizatorului câte un mesaj scurt de progres la fiecare pas: research-ul și generarea pozelor durează.

## 0. Reamintiri
La început, spune-i utilizatorului ce e în memorie (MEMORY.md și fișierele legate) despre problemele eMAG nerezolvate.

## 1. Date din DB
- Rulează `.claude/skills/emag-listare-perfecta/scripts/produs_din_db.sh <COD_PRODUS>`. Datele vin DOAR din DB (`catalog_products`), nu din Excel-urile din FISIERE.
- Citește și oferta de pe eMAG (doar citire), pentru că pe eMAG pot fi mai multe caracteristici decât în copia locală:
  `docker cp $SK/emag_oferta_citeste.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/emag_oferta_citeste.js <offer_id>`
- Semnalează ce e greșit: descriere șablon de la alt produs, caracteristici incomplete (mai ales „Destinat pentru” și alte filtre), poze puține sau doar pe platforma `en`, variante din familie cu nume sau culori greșite.
- `nr_bucati` și dimensiunile din DB: vezi lecțiile. Nu le modifica.
- Dacă nu există link de furnizor, întreabă. Nu inventa specificații.

## 2. Research pe eMAG (WebFetch)
- Pagina produsului (`https://www.emag.ro/search/<PNK>` sau linkul direct): preț, recenzii, specificații, variante.
- Căutări pe keyword-urile principale: titlurile și prețurile concurenților, filtrele din stânga.
- Recenziile de 1–3★ la concurenții direcți (ca să găsești fricile) și întrebările clienților.
- Din toate astea scoți: cum caută, ce compară, ce frici au, de ce cumpără, persona.

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
- Uită-te la contact sheet și **filtrează**: pagina conține și recomandări (alte produse), alte culori și poze cu obiecte care nu sunt în pachet.
- Raportează rezoluția: pozele Alibaba au adesea doar 750–800px, deci vor fi mărite cu `upsharp`.
- Verifică dimensiunile de pe poze față de text și între surse. Dacă se contrazic, arată-i utilizatorului un tabel cu sursa fiecărei valori și nu alege singur în tăcere.
- Ce arată alt vânzător în pachet (sticluță, inel de lemn) nu e automat pachetul nostru: întreabă.

## 4. Titlu, descriere și caracteristici
- **Titlu:** 80–120 de caractere, iar zona A (primele 50) trebuie să se înțeleagă singură pe telefon. Verifică-l cu `python3 .claude/skills/emag-listare-perfecta/scripts/verifica_listare.py titlu "..."`.
- **Descriere:** 200–350 de cuvinte, verificată cu `verifica_listare.py descriere - <<'EOF' ... EOF` sau `verifica_listare.py descriere fisier.txt`.
  - Fără bold markdown (`**`): aplicația transformă textul în HTML cu `<p>`, iar asteriscurile ar apărea literal pe eMAG.
  - Fără diacritice în titlu și descriere, pentru consecvență cu catalogul.
  - Bullets cu „- ” la început de rând.
  - Variantele dintr-o familie au același text; diferă doar culoarea sau mărimea.
- **Caracteristici:** propune valori DOAR din lista permisă a categoriei. Lista o iei doar citind, cu:
  `docker cp $SK/emag_categorie.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/emag_categorie.js <category_id> && docker cp emag-back:/tmp/categorie_<category_id>.json <dir>/`
  - Capcană: în categoria 116 valoarea e „Geamuri auto”, nu „Geamuri”.
  - Caracteristicile multi-valoare se trimit ca mai multe intrări cu același id.
  - Când `allow_new_value=1`, poți scrie o valoare nouă.
  - O valoare care nu poate fi dovedită se marchează și se cere utilizatorului.
- **Titlu și descriere în HU și BG** (de făcut întotdeauna, nu doar pe RO):
  - Citește ce e acum pe eMAG HU/BG: `trimite_texte.js` în dry-run (pasul 7) arată titlul și descrierea actuale. Des, descrierea lipsește sau titlul e o traducere automată cu `cod_produs` în față.
  - Nu traduce cuvânt cu cuvânt: pornește de la textul RO aprobat și adaptează keyword-urile la cum se caută pe emag.hu / emag.bg (verifică 1–2 căutări cu WebFetch). Aceleași reguli de lungime: titlu 80–120 de caractere, zona A înțeleasă singură; descriere 200–350 de cuvinte, bullets cu „- ”, fără `**`.
  - Spre deosebire de RO, aici **păstrezi diacriticele**: maghiara fără á, é, ő, ű e greu de citit, iar BG e în chirilică. Unitățile: „cm” în HU, „см” în BG.
  - Aceleași fapte ca pe RO (dimensiuni, conținutul pachetului, culoare): nimic în plus.
  - Scrie-le în `<dir>/texte_hu_bg.json` (`{"hu": {"name", "description"}, "bg": {...}}`) și verifică titlurile cu `verifica_listare.py titlu`.
- **Arată-i utilizatorului totul înainte de salvare**, într-un tabel înainte/după (RO, HU și BG), plus întrebările deschise.

## 5. Salvare în aplicație (doar local, după confirmare)
- Fă întâi backup cu valorile vechi: JSON în scratchpad cu `nume`, `descriere` și `characteristics`.
- Endpoint-ul `PATCH /api/catalog/product/:id` cere login, deci NU ocoli autentificarea. Rulează funcția aplicației în container, după ce copiezi descrierea cu `docker cp` într-un fișier:
  `docker exec -w /app emag-back node -e 'const fs=require("fs");require("./marketplace-db.js").updateProduct(<id>, {nume:"...", descriere: fs.readFileSync("/tmp/descriere.txt","utf8").trim()}).then(()=>process.exit(0))'`
- Caracteristicile sunt doar o copie locală text:
  `UPDATE marketplace_listings SET characteristics = '<id>: valoare; ...' WHERE product_id=<id> AND channel='emag'`
  Valorile multiple se despart prin virgulă. Rulează-l prin `docker exec emag-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" ...'`.
- Recitește din DB și confirmă ce s-a salvat.
- Butonul „Publică” din aplicație trimite doar preț/stoc/titlu/descriere, și doar pe RO. Caracteristicile și pozele NU pleacă prin el.
- Aplicația nu are titlu și descriere pentru HU/BG, deci acolo nu ai ce salva local: textele aprobate rămân în `<dir>/texte_hu_bg.json` până la „trimite pe eMAG” (pasul 7).

## 6. Poze pe limbi (RO, HU, BG): 8 poze de 2000×2000
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
- Scoate pozele care promit ceva ce nu e în set și textele promoționale. Acoperă TOT textul în engleză și logo-urile vânzătorilor.
- **Tehnic:**
  - Python + PIL (nu există numpy/cv2). Helperii sunt în `$SK/galerie_common.py`, iar exemplul complet în `$SK/build_lang_exemplu.py` și `$SK/texte_exemplu.json`.
  - Fonturile OpenSans Bold/ExtraBold (au diacritice RO și HU și chirilică) le copiezi în `<dir>/fonts/` din `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/162/fs/usr/share/fonts/opensans/`.
  - Un singur script `build_lang.py <lang>` care citește textele din `texte.json` (`{ro, hu, bg}`). Unitatea „cm” devine „см” în BG.
  - Titlu ≥120px (dacă trebuie micșorat mult, scurtează textul), etichete ≥60–80px, ≤20 de cuvinte pe imagine.
  - Verifică fiecare set de texte cu `verifica_listare.py infografic "titlu" "eticheta" ...`.
  - Uită-te la fiecare poză (contact sheet, plus crop la ~700px pe zonele reparate) și repară suprapunerile de text, liniile de cotă șterse și resturile de text în engleză.
  - Pe poze folosește diacritice corecte (ș, ț cu virgulă).
- **Încărcare în aplicație** (doar local), cu `docker cp out emag-back:/tmp/p<id>`, apoi:
  - galerie nouă: `docker exec -w /app emag-back node /tmp/imagini_app.js add <id> <cod_produs> /tmp/p<id>`;
  - înlocuirea unor poze: `... imagini_app.js replace <id> <cod_produs> /tmp/p<id> 4,5,8` (face deleteImage, addImages și reorder);
  - verificare: `... imagini_app.js list <id> - -`.

  Copiază întâi scriptul cu `docker cp $SK/imagini_app.js emag-back:/tmp/`. Compară apoi `byte_size` din DB cu fișierele generate.
- Trimite-i utilizatorului contact sheet-ul fiecărei limbi cu SendUserFile.

## 7. Trimitere pe eMAG (DOAR când utilizatorul spune explicit „trimite pe eMAG”)
Ordinea: întâi caracteristicile, apoi titlul și descrierea HU/BG, apoi pozele. Fiecare script rulează implicit în **dry-run**. Arată-i utilizatorului rezultatul și adaugă `send` doar după aceea.
- **Caracteristici:** scrie `schimbari.json` (`{"<id>": "valoare"}` sau `{"<id>": ["v1", "v2"]}` pentru multi-valoare), apoi:
  `docker cp $SK/trimite_caracteristici.js emag-back:/tmp/ && docker cp schimbari.json emag-back:/tmp/`
  `docker exec -w /app emag-back node /tmp/trimite_caracteristici.js <offer_id> /tmp/schimbari.json` pentru dry-run, apoi aceeași comandă cu `send`.
  - Scriptul face `product_offer/read` și trimite prin `product_offer/save` oferta completă așa cum e pe eMAG (name, description, images, stock, handling_time, vat_id, status, prețuri, family dacă există). Înlocuiește doar caracteristicile date, după ce le validează contra category/read.
  - Apoi recitește oferta și confirmă valorile.
- **Poze:** `docker cp $SK/trimite_poze.js emag-back:/tmp/ && docker exec -w /app emag-back node /tmp/trimite_poze.js <product_id> ro,hu,bg`. Asta e dry-run și verifică că URL-urile publice răspund 200. Apoi aceeași comandă cu `send`.
  - Logica e cea a endpoint-ului `POST /api/catalog/product/:id/images/push`: effectiveImages, `getChannel("emag").pushImages`, apoi markImagesPushed.
  - După push, scriptul recitește oferta pe fiecare platformă (`emagApiBase(platform)`) și compară numărul de poze.
- **Titlu și descriere HU/BG:** `docker cp $SK/trimite_texte.js emag-back:/tmp/ && docker cp texte_hu_bg.json emag-back:/tmp/`
  `docker exec -w /app emag-back node /tmp/trimite_texte.js <offer_id> hu,bg /tmp/texte_hu_bg.json` pentru dry-run (titlul și descrierea înainte/după), apoi aceeași comandă cu `send`.
  - Citește oferta pe fiecare platformă și o retrimite completă cu valorile ei (preț în HUF/BGN, stoc, caracteristici, poze), înlocuind doar `name` și `description`. Descrierea trece prin `textToHtml`, ca la „Publică”.
  - Apoi recitește și confirmă titlul și descrierea. Dacă trimiți și pozele pe HU/BG, trimite întâi textele, apoi pozele.
- Titlul și descrierea RO pleacă prin „Publică” din aplicație, fie de utilizator, fie la cererea lui explicită.
- Warning-ul „Please provide product characteristic values for the given family type” apare la produsele fără familie și nu blochează. „Invalid vendor ip” înseamnă că IP-ul serverului trebuie adăugat în contul eMAG HU/BG.

## 8. La final
Un rezumat scurt:
- ce e salvat local, ce e pe eMAG și pe ce platforme (inclusiv titlul și descrierea HU/BG);
- ce a rămas deschis: câmpuri suspecte din DB, valori nedovedite (aromă, conținutul pachetului), poze care ar trebui făcute real (de ex. înainte/după, produsul în mașină), conflicte de dimensiuni.

Actualizează memoria dacă s-a rezolvat sau a apărut o problemă eMAG de reamintit.

### Curățenie (obligatoriu, la sfârșitul listării)
Pozele finale sunt deja în aplicație (`product_images` + stocare), deci tot ce e pe disk sunt copii sau candidați (~20–45 MB pe produs). Șterge-le când utilizatorul nu mai cere modificări la poze și `imagini_app.js list` arată 8 poze pe ro/hu/bg cu `byte_size` egal cu fișierele generate:
- directorul produsului din scratchpad, cu tot ce conține (poze Alibaba, `desc/`, `img/`, `out/`, contact sheet-uri, ciorne, fonturi): `rm -rf <scratchpad>/<cod>`;
- tot ce ai copiat în container pentru acest produs: `docker exec emag-back sh -c 'cd /tmp && rm -rf p<id> n<id> descriere<id>.txt schimbari.json texte_hu_bg.json categorie_*.json alibaba_*.js emag_*.js imagini_app.js trimite_*.js'`;
- `.claude/tmp-imgsearch/`, dacă a rămas.

Excepție: dacă titlul și descrierea HU/BG nu au fost încă trimise pe eMAG, `texte_hu_bg.json` e singura lor copie. Pune-le întregi în rezumat (ca să rămână în conversație) înainte să ștergi directorul.

Nu șterge nimic din `/var/www/poze/`, din stocarea aplicației sau din `/tmp/node-compile-cache` din container. Spune-i utilizatorului în rezumat că ai făcut curățenia.
