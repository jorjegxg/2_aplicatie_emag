// Rulează cu javascript_tool pe pagina de rezultate a căutării după imagine (alibaba.com/search/page?...SearchScene=imageTextSearch...).
// Întoarce primele produse distincte: id, link, titlu+preț (din card).
(() => {
  const seen = new Set(), out = [];
  document.querySelectorAll('a[href*="/product-detail/"]').forEach(a => {
    const m = a.href.match(/_(\d{8,})\.html/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    const card = a.closest('[class*="card"],[class*="item"]') || a;
    out.push({ id: m[1], url: a.href.split('?')[0], t: (card.innerText || '').replace(/\s+/g, ' ').slice(0, 140) });
  });
  return JSON.stringify(out.slice(0, 20));
})()
