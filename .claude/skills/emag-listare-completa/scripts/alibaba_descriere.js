// Rulează cu javascript_tool pe https://www.alibaba.com/product-detail/description/descIframe.html?productId=<ID>
// Pozele de aici sunt deja originale: https://sc04.alicdn.com/kf/<id>/<nr>/<id>.jpg
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const imgs = [...document.querySelectorAll('img')].map(i => i.src || i.dataset.src).filter(Boolean)
    .map(u => u.replace(/^\/\//, 'https://').replace(/(\.(?:jpe?g|png|webp))(?:_[^/]*)?$/i, '$1'));
  return JSON.stringify({ imgs: [...new Set(imgs)], txt: document.body.innerText.slice(0, 4000) });
})()
