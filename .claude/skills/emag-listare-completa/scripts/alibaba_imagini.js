// Rulează cu mcp__claude-in-chrome__javascript_tool pe pagina de produs Alibaba (după ce s-a încărcat).
// Întoarce pozele la REZOLUȚIA ORIGINALĂ (fără sufixe _NNNxNNN / q80 / _.webp):
//   gal  = galeria (thumbnail-urile din stânga; în HTML apar ca "//s.alicdn.com/@sc0X/kf/<id>.jpg")
//   col  = pozele variantelor de culoare (thumbnail _100x100 de pe sc04.alicdn.com)
//   desc = pozele din descrierea inline (dacă există; altfel ia-le din descIframe.html?productId=<ID>)
//   attrs/variants = textul „Key attributes” și opțiunile (Color, Fragrance, ...)
// ATENȚIE: pagina conține și recomandări (alte produse) — filtrează vizual cu contact sheet-ul.
(async () => {
  for (const f of [0.25, 0.5, 0.75, 1]) { window.scrollTo(0, document.body.scrollHeight * f); await new Promise(r => setTimeout(r, 1200)); }
  window.scrollTo(0, 0);
  const orig = u => u.replace(/^["'(]/, '').replace(/^\/\//, 'https://').replace(/(\.(?:jpe?g|png|webp|avif))(?:_[^/]*)?$/i, '$1');
  const h = document.documentElement.innerHTML;
  const gal = [...new Set((h.match(/["'(]\/\/s\.alicdn\.com\/@sc0\d\/kf\/[A-Za-z0-9_]+\.(?:jpe?g|png|webp)/g) || []).map(orig))];
  const col = [...new Set([...document.querySelectorAll('img')].filter(i => /_100x100/.test(i.src) && !i.src.includes('@sc01')).map(i => orig(i.src)))];
  const desc = [...new Set([...document.querySelectorAll('[class*="description"] img, [id*="description"] img, [class*="detail-desc"] img')].map(i => orig(i.src || i.dataset.src || '')).filter(Boolean))];
  const t = document.body.innerText;
  const k = t.indexOf('Key attributes'), c = t.indexOf('Color');
  const id = (location.pathname.match(/_(\d{8,})\.html/) || [])[1];
  return JSON.stringify({ id, title: document.title.replace(/ - Buy Product.*$/, ''), gal, col, desc,
    variants: c >= 0 ? t.slice(c, c + 300) : '', attrs: k >= 0 ? t.slice(k, k + 900) : '',
    descIframe: id ? `https://www.alibaba.com/product-detail/description/descIframe.html?productId=${id}` : null });
})()
