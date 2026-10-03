---
name: emag-listare-perfecta
description: >-
  Construiește sau auditează cea mai bună listare eMAG pentru un produs: titlu
  gândit pentru mobil (primele 50 de caractere vând singure), galerie de 7–8
  poze cu roluri, infografice lizibile pe telefon, descriere de 200–350 de
  cuvinte, dimensiuni și caracteristici complete, cu reguli măsurate pe emag.ro
  și un script care arată exact ce se vede din titlu pe fiecare ecran. Folosește
  skill-ul ori de câte ori utilizatorul cere titlu, descriere, poze, infografice,
  texte pe poze, listare, relistare, optimizare, audit sau „de ce nu se vinde”
  pentru un produs eMAG (sau eMAG HU/BG), chiar dacă nu spune „skill” sau
  „listare perfectă”. Use for any eMAG product title/description/image/listing
  copy request or listing review.
---

# Cea mai bună listare pe eMAG

Scopul: o listare care apare în căutare, primește click pe telefon și răspunde la toate întrebările clientului înainte să le pună. Fiecare regulă de mai jos are un motiv; când un produs nu se potrivește unei reguli, păstrează motivul și adaptează regula.

Ghidul lung (preț, recenzii, lansare, PNK): [`FISIERE/GHID-LISTARE-EMAG-VINDE.md`](../../../FISIERE/GHID-LISTARE-EMAG-VINDE.md). Cum au fost măsurate cifrele și cum le re-măsori: [`references/masuratori.md`](references/masuratori.md).

## Cifrele care dictează tot

**Mobilul e aproape tot traficul.** De Black Friday 2025, 87,75% dintre clienți au intrat de pe mobil (date oficiale eMAG). De aceea construiești listarea pentru telefon, iar desktopul vine pe locul doi.

**Titlul se vede doar pe jumătate.** În rezultatele căutării, titlul e scris cu 14px și are maximum 3 rânduri. Restul e tăiat. Valorile de mai jos sunt măsurate pe CSS-ul emag.ro din septembrie 2026:

| Ecran | Caractere vizibile | Cuvinte vizibile |
|---|---|---|
| Telefon 360px | ~50 | ~7 |
| iPhone 390px | ~58 | ~8 |
| Android 412px | ~62 | ~9 |
| Laptop 1366–1529px | ~77 | ~11 |
| Monitor 1920px | ~103 | ~15 |

În carusele (de exemplu „Produse similare”) se văd doar 2 rânduri. Aplicația nativă n-a putut fi măsurată; presupune tot ~50–60 de caractere.

## Datele produsului: doar din baza de date

Toate datele despre produs vin din baza de date a aplicației. Nu citi Excel-urile din `FISIERE/` (`Excel Comanda Produse.xlsx` și celelalte); utilizatorul a cerut explicit ca sursa să fie baza de date. Nu inventa specificații.

Primul pas la orice produs:

```bash
.claude/skills/emag-listare-perfecta/scripts/produs_din_db.sh <id | cod_produs | PNK | EAN | offer id | text din nume>
```

Scriptul folosește `DATABASE_URL` dacă e setat; altfel intră prin `docker exec` în containerul `emag-db`. Afișează 6 secțiuni:

| Secțiune | Ce găsești | Cum folosești |
|---|---|---|
| **Detalii** | Din `catalog_products`: `nume` (titlul actual), `descriere` (descrierea actuală), `brand`, familie, PNK, `lungime x latime x inaltime` (cm), `greutate` (kg), linkuri de furnizor (`link_cumparare`, `link_ali`, `link_amz`) | Baza pentru toată listarea |
| **Variante din familie** | Produsele din aceeași `product_families` (culori, mărimi) | Același text, diferă doar culoarea sau mărimea de la finalul titlului și din caracteristici |
| **Caracteristici eMAG salvate** | Din `marketplace_listings.characteristics`, ca perechi `id: valoare` | Le compari cu filtrele categoriei ca să vezi ce lipsește |
| **Poze încărcate** | Din `product_images`, pe platforme (en/ro/bg/hu) și în ordine | Nume ca `…384x528.jpg` înseamnă rezoluție mică: semnalează-le. Pozele în sine sunt în spatele login-ului aplicației; dacă trebuie văzute, cere-i utilizatorului o captură sau să le deschidă din aplicație. |
| **Ce lipsește** | Dimensiuni, greutate, link de furnizor, descriere, brand propriu, poze, caracteristici | Ce lipsește se cere utilizatorului, nu se completează din presupuneri |
| **Familii cu dimensiuni diferite** | Variante din aceeași familie cu dimensiuni diferite | Posibilă eroare de date: verifică cu utilizatorul înainte să pui cifrele în titlu sau în poze |

**Brand.** `OEM`, sau brand lipsă, înseamnă fără brand propriu, deci brandul nu apare în titlu.

**Link de furnizor.** Dacă nu există niciun link de furnizor în baza de date, cere linkul. Specificațiile tehnice (material, densitate, ce e în cutie) vin de acolo sau de la utilizator.

**Audit.** Pentru un produs care e deja listat, `nume` și `descriere` sunt varianta „înainte”. Treci-le prin `verifica_listare.py` ca să arăți concret ce e greșit la ele.

## Pașii, în ordine

### 1. Ce caută omul la produse de genul ăsta

Research-ul se face înainte de orice text. Titlul și pozele se construiesc cu cuvintele clientului, nu cu ale furnizorului.

| Sursa | Ce extragi | Unde folosești |
|---|---|---|
| Autocomplete eMAG, în incognito | Cuvintele exacte pe care le tastează oamenii | Titlu (keyword-ul principal) și caracteristici |
| Filtrele din stânga ale categoriei | Criteriile după care aleg | Caracteristici completate 100% |
| Recenzii de 1–3 stele la concurenți | Fricile și obiecțiile | Poze 3–7 și bullets |
| Recenzii de 5 stele la concurenți | De ce au cumpărat, cu cuvintele lor | Poza 2, fraza de deschidere, bullets |
| Întrebările clienților la concurenți | Informațiile care lipsesc din listările lor | Descriere și infografice |

Din research ies 3 liste scurte:
- **cum caută:** 5–10 keywords;
- **ce compară:** 3–5 criterii;
- **de ce le e frică:** 3–5 obiecții.

Dacă nu poți accesa eMAG, spune asta și marchează keyword-urile drept presupuneri.

### 2. Ce îi face să cumpere

Oamenii decid în ordinea: **am o problemă → asta o rezolvă → am dovadă → risc mic.**

- **Scapă de o durere.** O durere dispărută vinde mai bine decât o plăcere promisă: „nu te mai doare spatele după 2 ore de condus” bate „confort maxim”.
- **Dovada e o cifră.** „38x33 cm” sau „husă la 30°C” spun mai mult decât „calitate superioară”.
- **Clientul trebuie să fie sigur că i se potrivește.** Dimensiunile și compatibilitatea sunt motivul nr. 1 de retur.
- **Clientul trebuie să se vadă cu produsul.** Poza 2 arată o persoană care îl folosește.
- **Fără promisiuni medicale.** Scrie „reduce presiunea pe zona lombară”, nu „vindecă hernia”, care e un risc de respingere.

### 3. Cele 7 întrebări la care listarea trebuie să răspundă

| # | Întrebarea clientului | Unde răspunzi |
|---|---|---|
| 1 | Ce e? | Primele 3 cuvinte din titlu și poza 1 |
| 2 | Pentru ce și pentru cine? | Titlu (slotul 2), poza 2, secțiunea „Pentru cine” |
| 3 | Mi se potrivește? | Poza 3 (dimensiuni), caracteristici, specificații |
| 4 | E de calitate? Din ce e făcut? | Poza 5 (detaliu de aproape), bullets |
| 5 | Cum se folosește sau se montează? | Poza 4, descriere |
| 6 | Ce primesc în cutie? | Poza 6, descriere |
| 7 | Cum îl întrețin și cât ține? | Descriere |

**Testul:** cine vede doar titlul și primele 4 poze poate răspunde la întrebările 1–4?

Politica de retur nu intră în descriere; eMAG o afișează singur.

### 4. Pentru cine e produsul

- **O persona principală** apare în titlu și în poza 2.
- **2–3 persone secundare** apar în descrierea de la secțiunea „Pentru cine este”.
- Nu înghesui 4 tipuri de clienți în titlu: primele 50 de caractere sunt prea valoroase.

### 5. Jargon sau cuvinte pentru toată lumea

- **În titlu** pui cuvântul pe care îl caută lumea, chiar dacă nu e termenul tehnic corect. Jargonul intră în titlu doar dacă apare și în autocomplete; „memory foam” e căutat, deci rămâne.
- **În bullets** folosești formula „[beneficiul în cuvinte simple] — [dovada tehnică]”.

| Jargon | Cuvinte pentru toată lumea |
|---|---|
| Densitate 50 kg/m³ | Nu se turtește — spumă densă de 50 kg/m³ |
| IPX4 | Rezistă la stropi de apă (IPX4) |
| Design ergonomic | Urmează curbura spatelui |
| Poliester 600D | Material gros, nu se rupe (600D) |

- Valoarea tehnică pură merge în specificații, pentru cei care compară.
- Frazele au maximum 15 cuvinte.
- Nu folosi engleză decât dacă e un termen pe care lumea îl caută.

### 6. Titlul

Formula oficială eMAG este Tip produs + Brand + Model + caracteristici cheie. Aici o împarți în 3 zone, după ce se vede pe fiecare ecran:

| Zona | Caractere | Cine o vede | Ce pui |
|---|---|---|---|
| **A** | 1–50 (~7 cuvinte) | Toată lumea | Tipul produsului, pentru ce/cine, diferențiatorul principal. Trebuie să vândă singură. |
| **B** | 51–80 | Laptop | Beneficiu sau dovadă, apoi brandul |
| **C** | 81–120 | Pagina produsului și căutarea internă | Dimensiuni, culoare, un keyword secundar |

**Lungimea:**
- Ținta este 80–120 de caractere, adică 12–17 cuvinte.
- eMAG acceptă maximum 255, dar peste ~150 de caractere textul nu se mai vede nicăieri și titlul arată a spam.
- Keyword-urile secundare merg în caracteristici și descriere, nu în coada titlului.

**Brandul:** un brand necunoscut pus la început consumă un rând întreg pe telefon, deci îl pui în zona B. Îl scrii doar dacă e verificabil.

**Nu pui în titlu:**
- MAJUSCULE, emoji sau ★ ✔ !
- preț, „reducere”, „livrare gratuită”, „premium”, „cel mai bun”
- branduri concurente

**Formatul:**
- Dimensiunile se scriu `38x33 cm`, cu unitate.
- Diacriticele sunt consecvente în tot catalogul: ori peste tot, ori nicăieri. Dacă le folosești, folosește ș ț cu virgulă.

**Verifică fiecare titlu propus cu scriptul:**

```bash
python3 .claude/skills/emag-listare-perfecta/scripts/verifica_listare.py titlu "Titlul propus"
```

Scriptul arată ce se vede pe fiecare ecran și semnalează lungimea, majusculele, cuvintele promoționale, simbolurile, dimensiunile fără unitate și diacriticele cu sedilă. Rescrie titlul până când zona A se înțelege singură pe telefonul de 360px.

Exemplu verificat (113 caractere, 17 cuvinte):
> Perna lombara pentru scaun auto si birou, memory foam, sustine spatele, Maiestate, husa lavabila, 38x33 cm, negru

- Pe telefonul de 360px se vede „Perna lombara pentru scaun auto si birou, memory foam,”.
- Pe laptop se vede până la „…sustine spatele, Maiestate,”.

### 7. Pozele: 7–8 imagini, fiecare cu un rol

Pe telefon galeria se dă cu degetul, iar descrierea e ascunsă mai jos. De aceea pozele fac vânzarea, și majoritatea oamenilor văd doar primele 3–4.

| # | Rol | Ce trebuie să iasă bine |
|---|---|---|
| 1 | Recunoaștere | Fundal alb #FFFFFF, fără text, logo sau watermark; produsul ocupă 85–90% din cadru. Testul: la 150×150px se recunoaște instant (miniatura din grilă are ~170px). |
| 2 | Dorință | Persona principală folosind produsul |
| 3 | Potrivire | Dimensiuni cotate și un obiect de referință (mână, om, scaun) |
| 4 | Mecanism | Cum funcționează sau cum se montează: săgeți, maximum 3 pași |
| 5 | Calitate | Detaliu de aproape: material, cusătură, fermoar |
| 6 | Pachet | Tot ce e în cutie, numerotat |
| 7 | Contrast | „Cu vs. fără” sau „noi vs. standard” |
| 8 | Pentru cine (opțional) | 3 situații de folosire |

**Parametri tehnici:** 2000×2000px, JPG, sub 6MB, sRGB.

**Textele de pe pozele 2–8** se scriu în română, plus versiunile pentru piețele pe care vinzi (HU, BG).

### 8. Infograficele

Pe telefon, o poză de 2000px e afișată la ~390px, adică micșorată de ~5 ori. De aici vin mărimile minime:

| Element | Mărime minimă în poza de 2000×2000px |
|---|---|
| Titlul infograficului | ≥120px |
| Textul explicativ | ≥80px |
| Orice alt text | Niciodată sub 60px |

**Câte cuvinte:** titlul infograficului are maximum 5 cuvinte, cu maximum 3 etichete de câte cel mult 4 cuvinte. **În total, maximum 20 de cuvinte pe imagine.**

**Alte reguli:**
- O singură idee pe imagine.
- Lasă o margine liberă de ~100px.
- Contrast puternic; textul stă pe fundal, nu peste produs.
- Textul e doar informativ, niciodată promoțional.

**Verifică textele cu scriptul:**

```bash
python3 .claude/skills/emag-listare-perfecta/scripts/verifica_listare.py infografic "Titlu imagine" "eticheta 1" "eticheta 2"
```

**Testul uman:** telefonul ținut la distanța brațului, textul citit în 3 secunde.

### 9. Dimensiunile produsului

- **Același format peste tot:** `L x l x Î cm` = `lungime x latime x inaltime` din baza de date, cu aceleași cifre în titlu, poza 3, specificații și caracteristici.
- **Dimensiunea intră în titlu** doar când e criteriu de alegere: perne, huse, covoare, organizatoare.
- **Poza 3 are întotdeauna un obiect de referință.** „E mai mic decât credeam” e cel mai des motiv de retur.
- **Greutatea** se trece când acolo e o frică a clientului („e prea greu”, „e prea ușor ca să fie stabil”).

### 10. Descrierea: 200–350 de cuvinte

Descrierea o citește doar cine e încă nehotărât, și o citește pe telefon, deci trebuie scanabilă.

| Bloc | Cuvinte |
|---|---|
| Fraza de deschidere (problemă → soluție) | 15–20 |
| 5 bullets care încep cu beneficiul, 2–4 cuvinte în bold | 12–20 fiecare |
| Pentru cine este: 3–4 profiluri | ≤10 fiecare |
| Specificații | Doar cifre |
| Întreținere și folosire | 30–50 |
| Ce conține pachetul | Doar listă |

Un paragraf are maximum 40 de cuvinte, adică ~3 rânduri pe telefon.

**Interzis în descriere:**
- linkuri sau date de contact;
- preț, livrare, garanție sau stoc;
- mesaje promoționale;
- descrierea unei familii de produse.

Nu copia descrierea furnizorului.

**Verifică descrierea cu scriptul:**

```bash
python3 .claude/skills/emag-listare-perfecta/scripts/verifica_listare.py descriere fisier.txt
```

### 11. Caracteristicile

Completează toate caracteristicile, inclusiv cele opționale. Fiecare filtru din stânga lăsat gol te face invizibil pentru cine filtrează: nu apari deloc, nu doar mai jos în listă. Nu inventa valori; o valoare necunoscută se marchează și se cere utilizatorului.

## Formatul răspunsului

```markdown
## Research
- Cum caută (keywords): …
- Ce compară (criterii / filtre de completat): …
- Frici și obiecții: …
- De ce cumpără (cuvintele clienților): …
- Persona principală / secundare: …

## Date din DB
- Produs: id … / cod_produs … / familie … / variante: …
- Dimensiuni: … x … x … cm, … kg | Brand: … | Link furnizor: … (sau „lipsă — cerut”)
- Ce lipsește (din script): …

## Titlu
- Titlul actual și ce e greșit la el (dacă există)
- Titlul recomandat + ieșirea scriptului (ce se vede pe 360px / laptop)

## Cele 7 întrebări → unde e răspunsul
(tabel: întrebare → titlu / poza # / descriere / caracteristică)

## Galerie (7–8 poze)
Pentru fiecare: rol, ce arată, textul de pe imagine (RO + HU/BG), numărul de cuvinte

## Descriere (200–350 de cuvinte)
Textul gata de lipit + numărul de cuvinte din script

## Caracteristici de completat
- Din filtre: … | Necunoscute (de cerut): …

## Checklist numeric
- [ ] Titlu 80–120 car., zona A (50 car.) se înțelege singură
- [ ] Poza 1 albă, fără text; 7–8 poze de 2000×2000px, fiecare cu un rol
- [ ] Infografice: ≤20 de cuvinte, titlu ≥120px, text ≥80px
- [ ] Descriere 200–350 de cuvinte, bullets ≤20, paragrafe ≤40
- [ ] Aceleași dimensiuni peste tot; toate caracteristicile completate
```

Când utilizatorul cere doar o parte (de exemplu doar titlul), livrează doar acea parte, dar păstrează research-ul scurt de la început: fără el, titlul e scris pe ghicite.
