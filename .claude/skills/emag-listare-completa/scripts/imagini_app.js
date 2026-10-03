// Poze în APLICAȚIE (doar local, product_images + stocare) — nu trimite nimic pe eMAG.
// Rulează în container:  docker exec -w /app emag-back node /tmp/imagini_app.js <mod> <product_id> <cod_produs> <dir_out_in_container> [poziții]
//   mod=list     -> doar citire: ce poze are produsul pe ro/hu/bg (cod_produs și dir pot fi „-”)
//   mod=add      -> adaugă 01..08.jpg din <dir>/<ro|hu|bg>/ pe fiecare platformă (când platforma e goală)
//   mod=replace  -> înlocuiește doar pozițiile date (ex. 4,5,8): deleteImage + addImages + reorder, păstrând ordinea
// Exemplu: docker cp out emag-back:/tmp/p56 && docker exec -w /app emag-back node /tmp/imagini_app.js replace 56 PARF-SOL-AURIU /tmp/p56 4,5,7,8
const fs = require("fs");
const pi = require("/app/product-images.js");
const { Pool } = require("/app/node_modules/pg");
const [mode, idS, code, dir, posS] = process.argv.slice(2);
const id = Number(idS);
const LANGS = ["ro", "hu", "bg"];
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const file = (L, n) => { const b = fs.readFileSync(`${dir}/${L}/${n}.jpg`); return { originalname: `${code}_${L}_${n}.jpg`, mimetype: "image/jpeg", buffer: b, size: b.length }; };
  for (const L of LANGS) {
    const cur = (await pool.query("select id, original_name from product_images where product_id=$1 and platform=$2 order by sort_order", [id, L])).rows;
    if (mode === "list") {
      // doar afișare
    } else if (mode === "add") {
      if (cur.length) throw new Error(`${id} ${L} are deja ${cur.length} poze — folosește replace`);
      const n = fs.readdirSync(`${dir}/${L}`).filter(f => /^\d\d\.jpg$/.test(f)).sort();
      await pi.addImages(id, n.map(f => file(L, f.slice(0, 2))), L);
    } else if (mode === "replace") {
      const order = cur.map(r => r.id);
      for (const p of posS.split(",").map(Number)) {
        const n = String(p).padStart(2, "0");
        const old = cur[p - 1];
        if (!old || !old.original_name.endsWith(`_${L}_${n}.jpg`)) throw new Error(`poziția ${p} pe ${L} nu e ${code}_${L}_${n}.jpg (e ${old && old.original_name})`);
        await pi.deleteImage(id, old.id);
        const added = await pi.addImages(id, [file(L, n)], L);
        order[p - 1] = added[0].id;
      }
      await pi.reorder(id, order, L);
    } else throw new Error("mod necunoscut: " + mode);
    const after = (await pool.query("select original_name, byte_size from product_images where product_id=$1 and platform=$2 order by sort_order", [id, L])).rows;
    console.log(id, L, after.map(r => r.original_name.replace(/^.*_(\w\w_\d\d)\.jpg$/, "$1")).join(","));
  }
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e.message || e); process.exit(1); });
