---
name: emag-listing-copy
description: >-
  Creates eMAG listing copy that converts — Romanian titles (5-slot formula +
  official Tip+Brand+Model), gallery roles, benefit-led descriptions, full
  characteristics for filters, multi-language image overlay text (RO/HU/BG+),
  and .99 pricing — after buyer research via LINK DE REFERINTA and Excel SIZE vs
  DB dimensions. Use when the user asks for titlu, descriere, listare eMAG,
  texte pe poze, listing copy, product SEO, packshot, or conversion listing.
---

# eMAG listing copy

Generate marketplace-ready listing content for this project's products. Always research the buyer first; never invent specs.

Full conversion guide (source text): [`FISIERE/GHID-LISTARE-EMAG-VINDE.md`](../../../FISIERE/GHID-LISTARE-EMAG-VINDE.md).

## Mental model — three filters (+ Buy Button)

Sales pass through filters in order. Failing one makes the rest irrelevant:

| Filter | Decides | Influenced by |
|--------|---------|---------------|
| 1. Indexare | Appear in search or not | Title, completed characteristics, category, brand |
| 2. Click | Choose you or scroll past | Main image, title (~first 60 chars), price, rating, badges |
| 3. Conversie | Buy or leave | Gallery, description, specs, reviews, delivery |

Most sellers optimize only filter 1. Money is made in filters 2 and 3.

**Invisible 4th filter — Buy Button / PNK:** If the offer is associated to an existing documentation (shared PNK), you compete on price, stock, seller rating, delivery speed, return rate. Prefer **own documentation** (unique product, bundle, own brand) over crowded PNKs when possible. Do not invent uniqueness claims.

## Checklist (keep meaning; use as workflow gates)

One product

- photo 1: good proportions, large, centered, white background, no text
- photos translated into their market languages
- photos 2000px × 2000px
- DO RESEARCH WITH AI
  - ENTER THE BUYER'S MIND
    - WHICH CHARACTERISTICS THEY LOOK FOR
    - WHAT MAKES PEOPLE BUY
  - eMAG autocomplete keywords + category filters (left rail)

(WHEN BUILDING THE LISTING: IMAGES, TITLES, FEATURES, DESCRIPTIONS, PRICES)

- `.99` AT THE END (mass-market; round prices OK for premium positioning)

## Data sources (required)

1. Open [`FISIERE/Excel Comanda Produse.xlsx`](../../../FISIERE/Excel%20Comanda%20Produse.xlsx) — headers on **row 3**.
   - Same file as `c:\Users\yotre\OneDrive\Desktop\2_aplicatie_emag\FISIERE\Excel Comanda Produse.xlsx` when the project lives on that Windows path.
2. Match the product by `NAME` / `NUME IN ROMANA` / `COLOR` / `SIZE` (or user SKU).
3. Read **`LINK DE REFERINTA`** — purchase/supplier URL. Use it for specs, materials, dimensions, and visual cues.
4. Also use when present: `NAME`, `ALIEXPRESS NAME`, `ALIBABA NAME`, `MATERIAL`, `COLOR`, `SIZE`, `NUME IN ROMANA`.
5. Read DB dimensions for the matched catalog product: `inaltime`, `lungime`, `latime` (cm) on `catalog_products` — via app UI, `GET /api/products`, or Postgres (`DATABASE_URL`).

If `LINK DE REFERINTA` is missing: ask for the URL, or use `link_cumparare` from the catalog / website export. Do not invent a supplier link.

## Dimension check (Excel vs DB) — mandatory

Before writing copy, compare Excel dimensions to DB and **tell the user clearly if they differ**.

| Source | Field(s) | Notes |
|--------|----------|--------|
| Excel | `SIZE` | Free text (e.g. `45*40*30`, `500 cm`, `.`). Parse numbers when possible. |
| DB | `inaltime`, `lungime`, `latime` | Numeric cm on `catalog_products`. |

Rules:

1. Parse Excel `SIZE` into comparable numbers (split on `*`, `x`, `×`, or spaces; ignore junk like `.` alone).
2. Compare to DB `inaltime` / `lungime` / `latime` (cm). Order in Excel is often L×W×H or similar — if ambiguous, report both raw Excel `SIZE` and the three DB values; do not silently assume axis mapping.
3. Treat as **different** when: parsed values disagree (beyond trivial rounding, e.g. 0.1 cm), Excel has dimensions and DB is null/incomplete, or DB has dimensions and Excel `SIZE` is empty/unusable.
4. Always include a **Dimensions Excel vs DB** section in the output (match / differ / incomplete), with both sides shown.
5. Prefer **verified facts** for listing copy: if Excel and DB conflict, flag it and ask which source is correct before locking dimensions into title/description; do not invent a third value.

## Workflow (mandatory order)

1. **Identify product** from user input + Excel row(s) / color variants.
2. **Dimension check** (Excel `SIZE` vs DB `inaltime`/`lungime`/`latime`) — report match or difference.
3. **Open LINK DE REFERINTA** (fetch or summarize from available data). Extract factual specs only.
4. **Buyer research (enter the customer's mind)** before any copy:
   - What search queries would they type on eMAG (RO)? Prefer **eMAG autocomplete** (incognito → type seed phrase) and top reviewed titles in category.
   - What **filters** appear on the left in category? Those map to characteristics that must be filled.
   - What characteristics do they compare (material, size, fit, comfort, mounting, color)?
   - What problem do they have, and what **resolution/solution** makes them buy (pain → solution → proof → low risk)?
5. **Build listing**: gallery roles → title critique+recommend → feature bullets (benefit + proof) → description critique+recommend → image texts (RO + other markets) → characteristics reminder → price `.99` only if asked.
6. Output in the **Output format** below. One block per color variant when variants differ only by color (shared title/description OK; note color in variant line).

## Buyer research rules

- Prefer **search language of the buyer**, not supplier jargon (Alibaba title ≠ eMAG title).
- `NUME IN ROMANA` is a category seed (e.g. PERNE DE MASAJ), not the final title.
- Characteristics people look for: material, dimensions, compatibility (auto/office), benefit (pain/comfort), how to install, washable/cover, color options.
- Purchase drivers: clear problem fix, visible quality cues, universal fit, easy install, concrete dimensions, trust (memory foam, ergonomic, etc. — only if true).
- **Keyword rule:** primary keyword in title; secondary keywords in characteristics + description — do not stuff all into the title.
- Free keyword method: eMAG search autocomplete + left-rail filters + top 10 titles by review volume.

## Conversion psychology (apply in copy & gallery)

Use when writing titles, bullets, descriptions, and image themes:

1. **Loss aversion** — prefer removing a pain (“nu mai rămâi cu spatele rupt…”) over vague pleasure (“confort maxim”).
2. **Specificity = credibility** — numbers beat adjectives (“suportă 120 kg”, not “foarte rezistent”).
3. **Cognitive load** — answer without friction: fit? size? material? cleaning? what if I dislike it?
4. **Social proof** — do not invent reviews; if rating exists, do not oversell perfection.
5. **Imagined ownership** — context photo with person (gallery #2) beats another white-packshot angle.
6. **Contrast** — “cu vs. fără” is a high-conversion visual format.
7. **Characteristic → benefit → proof** — never leave a dry spec without the buyer outcome.

## Title (RO)

**Official eMAG naming (Home&Deco / similar):** `Tip produs + Brand + Model + caracteristici cheie (mărime, culoare)`. Title must refer strictly to the product and stay coherent with images, description, and characteristics.

**Primary working formula (slots, in order):**

`[Ce este] [Pentru cine/unde] [Brand] [Diferențiator] [Specificație cheie]`

| Slot | Content | Rules |
|------|---------|-------|
| Ce este | Product type (buyer search language) | Required. Exact primary keyword when possible. Use `NUME IN ROMANA` as seed, not copy-paste. |
| Pentru cine/unde | Use context / compatibility | Required when relevant (auto, birou, copii, etc.). |
| Brand | Product brand | **Only if verifiable** from Excel / link / catalog. Otherwise omit. |
| Diferențiator | Benefit + proof | **Required:** problem→solution + material/proof if it fits. Kill one objection (washable, fit, size). |
| Specificație cheie | Size / capacity / color | Optional; include if it helps SEO and is verified. Color often last (eMAG habit). |

**Three jobs of the title (simultaneous):**

1. Exact keyword the shopper types (indexare).
2. Reads well in the **first ~60 characters** (mobile list truncation).
3. Removes one objection before click (size, compatibility, material).

**Length:** optimal **60–120 characters**; first ~60 must stand alone. Count chars. Prefer under 120; never keyword-spam past that.

**Do:**

- Diacritics consistent across catalog (all with or all without — do not mix in one title).
- Digits for sizes: `35x30 cm`.
- One product per title; shopper search words; real synonyms (“lombară” + “pentru spate”) when they fit length.

**Don't:**

- ALL CAPS words, emoji, ★ ✔ ❗
- Prices, “reducere”, “promoție”, “livrare gratuită”
- Empty marketing (“premium”, “calitate superioară”)
- Competitor brands or “compatibil cu X” without rights / verification
- Keyword stuffing (spam look → distrust / rejection risk)

**Examples:**

- ❌ Too thin: `Perna lombara auto`
- ❌ Stuffing: long keyword salad with every synonym and “premium calitate”
- ✅ Good: `Perna lombara auto Maiestate, suport ergonomic pentru scaun, memory foam, husa detasabila, negru`
- ✅ Style (no brand): `Pernă lombară, auto, spumă memory foam suport ergonomic spate, 40×38×11 cm`

**Always critique then recommend** (see Output format).

## Description (RO)

**This skill outputs plain text** (blank line between paragraphs) for easy paste. eMAG upload may allow simple HTML (`<br>`, `<ul>`, `<li>`, `<p>`, `<b>`); do not invent HTML unless the user asks for HTML-ready copy.

**Structure that converts (scan, don’t write essays):**

1. **Hook sentence** — what it does for the buyer (~15 words).
2. **4–6 benefit bullets** — start with result, not feature; each: characteristic → benefit → proof.
3. **Pentru cine este** — 3–4 concrete profiles.
4. **Specificații tehnice** — measurable facts only.
5. **Întreținere / utilizare** — kill post-purchase fear.
6. **Ce conține pachetul**.

**eMAG forbids in description:**

- Links / text / images / video pointing to other products or external sites
- Offer info: price, delivery term, availability, warranty (use platform fields)
- Seller contact details
- Promo messages (“Ofertă limitată!”, “Cumpără acum!”, “Super ofertă”)
- One description covering a whole product family (one description = one product)

**Allowed:** objective benefits, functions, characteristics; facts only from Excel + supplier link (+ DB when dimensions agreed). Mark unknowns; do not invent certifications or materials.

**Never copy the supplier description** (duplicate content + Chinese translation errors destroy trust). Re-check anatomical terms, materials, units.

**Always critique then recommend** (see Output format).

## Feature bullets & characteristics

- Bullets in the listing copy: **benefit-first**, with a concrete proof when available.
- Remind the user: **fill ALL eMAG characteristics**, including optional ones — optional attributes become **search filters**; incomplete = invisible (binary, not ranking).
- Map left-rail category filters to attributes that must be filled.
- Do not invent filter values; use verified specs only.

## Images

### Official / technical (eMAG Academy — verify if rejected)

| Parameter | Value |
|-----------|--------|
| Min size (platform) | Often **640×640** (some docs cite 400×400); Fashion often **640×960** (2:3) |
| Recommended | **2000×2000 px** (zoom) |
| Max dimension | ~6000×6000 |
| Formats | JPG, PNG, GIF |
| Max file size | **~6–8 MB** (prefer under 6 MB) |
| Main background | **White** (recommended/required for most categories; grey sometimes OK; ambient only where category allows) |
| Product in frame | Centered, complete, ~**85–90%** of frame |
| Main image content | Product alone; no packaging collage; **no text, watermarks, logos, collages** on main |

**Rejected patterns:** pixelated/unclear; watermarks; text over product; mismatch with title/description/characteristics; wrong color/size variant.

### Gallery that sells (each photo kills an objection)

Order matters — most shoppers see only the first 3–4:

| # | Role | Shows |
|---|------|--------|
| 1 | Recognition | Product on white, 3/4 or front, no text |
| 2 | Context / desire | Mounted in use with a person — imagined ownership |
| 3 | Scale | Dimension callouts, large digits, mobile-readable |
| 4 | Benefit / mechanism | How it works / cross-section (informative, not promo slogans) |
| 5 | Material detail | Macro stitch / zipper / texture |
| 6 | In the box | Package contents |
| 7 | Contrast | With vs without, or vs standard |

**Overlay / infographic text (photos 2–N):**

- Never on photo 1.
- Informative only (dimensions, materials, how-to) — **not** “Cea mai bună!”, “Reducere!”.
- Keep text on background zones, not covering the product when possible.
- Translate into **market languages** (RO primary; HU, BG, and others the user sells on).
- Thumbnail test: shrink main image to ~**150×150** — product must be instantly recognizable.

Subtle contact shadow OK for depth; harsh shadows / fake edit marks — avoid. Dark products on white may need lighting that creates internal contrast (do not change background color).

## Price

- When suggesting sale price for mass-market: end with **`.99`** (e.g. `149.99`).
- Premium / designer positioning may use round numbers if the user prefers.
- Reminder only (do not invent margins): net profit after eMAG commission (often ~5–20% by category) + courier + VAT.
- PRP/anchor: only if honest and user provides it — false PRP risks offer suspension.
- Omit price section unless the user asks.

## Reviews & launch (advisory — only if user asks)

- Reviews: polite post-delivery ask to **all** customers via Message Center; no gifts/discounts for reviews; no fake reviews; answer negatives professionally.
- New listing first 30 days: complete documentation day 1; entry price sustainable; ads for data → fold winning keywords into attributes/description; fix listing gaps from repeated customer questions.
- Prefer own documentation over crowded PNK when strategy is discussed.

## Output format

```markdown
## Research (short)
- Search intent (RO) / autocomplete seeds: …
- Characteristics shoppers compare + category filters to fill: …
- Specs from link / Excel: …
- Purchase drivers: …
- Problem → resolution (for title Diferențiator): …
- Objections to kill (title / gallery / description): …

## Dimensions Excel vs DB
- Excel `SIZE`: …
- DB (cm): inaltime=…, lungime=…, latime=…
- Verdict: MATCH | DIFFER | INCOMPLETE
- If DIFFER / INCOMPLETE: what differs and which source needs confirmation

## Titlu — analiză și recomandare
### Cum e acum titlul
…   <!-- existing catalog / Excel / eMAG title; or “lipsă” -->

### De ce nu e bun titlul
- …   <!-- SEO, first 60 chars, problem→solution, stuffing, jargon, length, etc. -->

### Cum trebuie să fie titlul
- Official: Tip + Brand + Model + key specs
- Formula: `[Ce este] [Pentru cine/unde] [Brand] [Diferențiator] [Specificație cheie]`
- First ~60 chars readable; total 60–120; Brand only if verifiable; Diferențiator = problem→solution; no SKU/promo/emoji

### Titlu recomandat (RO)
…   <!-- count chars; note first-60 preview -->

## Feature bullets (benefit → proof)
- …
- …

## Descriere — analiză și recomandare
### Cum e acum descrierea
…

### De ce nu e bună / ce ar putea fi îmbunătățit
- …

### Descriere recomandată (RO)
…   <!-- hook → benefit bullets → pentru cine → specs → îngrijire → pachet -->

### De ce descrierea recomandată e mai bună
- …

## Caracteristici eMAG (reminder)
- Attributes / filters to complete from research: …
- Unknowns (do not invent): …

## Image texts / gallery plan
### Photo 1 — Recognition
White packshot, ~85–90% frame, 2000×2000, **no text**.

### Photo 2 — Context
- RO: …
- HU: …
- BG: …
(+ other languages if requested)

### Photo 3 — Scale
…

### Photo 4+ — …
…

## Suggested price
…99   <!-- only if user asked -->

## Pre-publish checklist (short)
- [ ] Title: primary keyword + formula + first 60 OK + no promo/emoji
- [ ] Main image: white, centered, no text; ≥5 gallery roles
- [ ] Description: own words; benefit+proof; no price/delivery/contact/promo
- [ ] All characteristics filled (esp. filter attributes)
```

## Quality bar

- Titles follow the **5-slot formula** (Brand omitted when not verifiable), **60–120 chars**, readable in first ~60, answer: shopper search words **and** problem resolution in Diferențiator — no stuffing.
- Always show **before/after critique** for title and description. Do not skip.
- Gallery: photo 1 clean; later photos each kill an objection; overlay text informative only; thumbnail-readable.
- Never copy competitor/supplier claims you cannot verify.
- Never skip the Excel vs DB dimension verdict.
- Remind to complete **all** characteristics that map to category filters.

## Official resources (verify when rules conflict)

- [Standarde documentare Home&Deco](https://marketplace.emag.ro/infocenter/emag-academy/standarde-de-documentare/standarde-documentare-categoria-homedeco/) (seller login)
- [Standard imagini produs](https://marketplace.emag.ro/infocenter/emag-academy/cum-se-adauga-un-produs/standardul-pentru-imaginea-principala-a-produselor/)
- [Filtre pe site](https://marketplace.emag.ro/infocenter/emag-academy/promovare/cum-functioneaza-filtrele-in-site-ul-emag/)
- [Ierarhizare / algoritmi P2B](https://marketplace.emag.ro/infocenter/emag-academy/cerinte-legale/ierarhizarea-produselor-si-algoritmii-platformei-emag-marketplace/)
- Seller UI: **Ofertele mele → Calitate conținut**
- FAQ marketplace: PNK, documentation owner, optional characteristics as filters
