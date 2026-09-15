# AI — Listare produs eMAG (titlu, descriere, texte pe poze)

**Cum folosești:** lipește acest fișier într-un chat AI, apoi dă produsul (nume / culoare / SKU) sau rândul din Excel. AI-ul trebuie să urmeze workflow-ul de mai jos înainte de a scrie copy.

**Aliniat cu:** `.cursor/skills/emag-listing-copy/SKILL.md`  
**Ghid complet (conversie):** `FISIERE/GHID-LISTARE-EMAG-VINDE.md`

---

## Model mental (filtre)

1. **Indexare** — titlu, caracteristici, categorie, brand  
2. **Click** — poza 1, titlu (~60 caractere), preț, rating  
3. **Conversie** — galerie, descriere, specs, recenzii  
4. **Buy Button / PNK** — preferă documentație proprie față de PNK aglomerat

---

## Checklist (verbatim)

Un produs

- poza 1 proportii ok mare centrata (fundal alb, fără text)
- poze traduse in limbile lor
- poze 2000px * 2000px
- FA RESEARCH CU AI-UL
    - SA INTRII IN MINTEA OMULUI
        - CE CARACTERISTICI CAUTA
    - CE II FACE PE OAMENII SA CUMPERE
    - autocomplete eMAG + filtre stânga categorie

(CAND CONSTRUIESTI LISTAREA IMAGINI, TITLURI, CARACTERISTICI, DESCRIERI, PRETURI)

- .99 LA SFARSIT

---

## Surse de date (obligatoriu)

1. Deschide `FISIERE/Excel Comanda Produse.xlsx` — header pe **rândul 3**.
2. Identifică produsul după NAME / NUME IN ROMANA / COLOR / SIZE (sau SKU-ul dat de tine).
3. Citește **`LINK DE REFERINTA`** — linkul de cumpărare/furnizor. Folosește-l pentru specs, materiale, dimensiuni, indicii vizuale.
4. Folosește și, dacă există: `NAME`, `ALIEXPRESS NAME`, `ALIBABA NAME`, `MATERIAL`, `COLOR`, `SIZE`, `NUME IN ROMANA`.
5. Compară `SIZE` (Excel) cu `inaltime` / `lungime` / `latime` din DB — raportează MATCH / DIFFER / INCOMPLETE.

Dacă lipsește `LINK DE REFERINTA`: cere linkul sau folosește `link_cumparare` din catalog / export website. Nu inventa link de furnizor.

| Coloană | Rol |
|---------|-----|
| `LINK DE REFERINTA` | link cumpărare — research obligatoriu |
| `NAME` / `ALIBABA NAME` / `ALIEXPRESS NAME` | nume EN + keywords sursă |
| `MATERIAL`, `COLOR`, `SIZE` | caracteristici factuale |
| `NUME IN ROMANA` | tip produs RO (ex. PERNE DE MASAJ) — start SEO, nu titlu final |

---

## Workflow (ordine obligatorie)

1. **Identifică produsul** din input + rândurile Excel / variante de culoare.
2. **Dimension check** Excel vs DB.
3. **Deschide LINK DE REFERINTA** — extrage doar fapte (specs).
4. **Research cumpărător** (înainte de orice copy):
   - Ce cuvinte caută pe eMAG (RO)? Autocomplete + titluri top recenzii.
   - Ce filtre apar în stânga pe categorie? (→ caracteristici de completat)
   - Ce caracteristici compară? Ce problemă → soluție îl face să cumpere?
5. **Construiește listarea**: galerie pe roluri → titlu (critică+recomandare) → bullets beneficiu→dovadă → descriere → texte pe poze (RO + alte piețe) → reminder caracteristici → preț `.99` doar dacă e cerut.
6. Livrează în **Format output** de mai jos.

---

## Reguli research (în mintea clientului)

- Limbajul de căutare al cumpărătorului, nu jargonul furnizorului.
- Keyword principal în titlu; secundare în caracteristici + descriere (fără stuffing).
- Motive: rezolvă o problemă, calitate vizibilă, fit, montare ușoară, dimensiuni concrete, dovezi reale.
- Psihologie: loss aversion, specificitate (cifre), reducere sarcină cognitivă, posesie imaginară (poză context).

---

## Titlu (RO)

**Oficial eMAG:** Tip produs + Brand + Model + caracteristici cheie (mărime, culoare). Coerent cu imagini / descriere / caracteristici.

**Formula principală (sloturi, în ordine):**

`[Ce este] [Pentru cine/unde] [Brand] [Diferențiator] [Specificație cheie]`

| Slot | Reguli |
|------|--------|
| Ce este | Obligatoriu. Keyword principal. Seed din `NUME IN ROMANA`. |
| Pentru cine/unde | Obligatoriu când e relevant (auto, birou…). |
| Brand | Doar dacă verificabil; altfel omis. |
| Diferențiator | Obligatoriu: problem→solution + dovadă; omoară o obiecție. |
| Specificație cheie | Opțional (dimensiune/culoare) dacă e verificat și ajută SEO. |

- Trei joburi: keyword exact + lizibil în primele ~60 caractere + elimină o obiecție.
- Lungime optimă **60–120** caractere.
- Fără SKU, preț, promo, majuscule, emoji, „premium”, stuffing.
- Exemplu: `Perna lombara auto Maiestate, suport ergonomic pentru scaun, memory foam, husa detasabila, negru`
- Fără brand: `Pernă lombară, auto, spumă memory foam suport ergonomic spate, 40×38×11 cm`

---

## Descriere (RO)

- Text simplu (sau HTML simplu doar dacă userul cere). Scrie pentru **scanare**.
- Structură: cârlig (~15 cuvinte) → 4–6 bullets beneficiu→dovadă → pentru cine → specs → îngrijire → pachet.
- Fără: linkuri externe, preț, livrare, garanție, contact, mesaje promo, familie de produse într-o singură descriere.
- Nu copia textul furnizorului. Verifică termeni (anatomie, materiale, unități).

---

## Caracteristici

- Completează **TOATE**, inclusiv opționale — devin filtre pe site (vizibil / invizibil).
- Bullets: rezultat întâi, apoi dovadă concretă.

---

## Imagini

- **Poza 1:** fundal alb, produs centrat ~85–90% cadru, **fără text**, 2000×2000.
- Galerie pe roluri: 1 recunoaștere → 2 context/persoană → 3 scară/cote → 4 beneficiu → 5 material → 6 pachet → 7 cu vs fără.
- Text pe 2–N: informativ (nu promo); nu peste produs dacă se poate; tradus RO/HU/BG+.
- Test miniatură ~150×150.

---

## Preț

- Când sugerezi preț mass-market, termină cu **`.99`**.
- Omite dacă nu a fost cerut. Profit net = după comision + curier + TVA.

---

## Format output

```markdown
## Research (scurt)
- Intent căutare (RO) / autocomplete: …
- Caracteristici + filtre de completat: …
- Specs din link / Excel: …
- Motive de cumpărare: …
- Problemă → rezolvare (Diferențiator): …
- Obiecții de omorât: …

## Dimensions Excel vs DB
- Excel SIZE: …
- DB: inaltime=…, lungime=…, latime=…
- Verdict: MATCH | DIFFER | INCOMPLETE

## Titlu — analiză și recomandare
### Cum e acum
…
### De ce nu e bun
…
### Cum trebuie (formula + primele 60 chars)
…
### Titlu recomandat (RO) + număr caractere
…

## Bullet caracteristici (beneficiu → dovadă)
- …
- …

## Descriere — analiză și recomandare
### Cum e acum
…
### Descriere recomandată (RO)
…
### De ce e mai bună
…

## Caracteristici eMAG (reminder)
…

## Texte pe poze / plan galerie
### Poza 1 — Recunoaștere
Packshot alb, fără text, 2000×2000.

### Poza 2 — Context
- RO: …
- HU: …
- BG: …

### Poza 3+ — …
…

## Preț sugerat
…99   <!-- doar dacă userul a cerut preț -->

## Checklist pre-publicare (scurt)
- [ ] Titlu / poze / descriere / caracteristici filtre
```

---

## Bară de calitate

- Titlul: formula pe 5 sloturi, 60–120 caractere, primele ~60 OK, problem→solution în Diferențiator, fără stuffing.
- Descriere: cuvinte proprii, beneficiu + dovadă, fără promo/ofertă în text.
- Galerie: fiecare poză omoară o obiecție; poza 1 fără text.
- Nu inventa specs. Nu sări peste verdictul Excel vs DB.
- Reminder: toate caracteristicile care apar ca filtre.

---

## Resurse eMAG

- Standarde documentare / imagini / filtre / P2B: marketplace.emag.ro/infocenter/emag-academy/
- Ofertele mele → Calitate conținut
- Ghid complet: `FISIERE/GHID-LISTARE-EMAG-VINDE.md`
