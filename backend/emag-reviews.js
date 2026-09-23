const { query } = require("./pg");
const { emagFetch } = require("./emag-client");

const CACHE_OK_MS = 6 * 60 * 60 * 1000;
const CACHE_FAIL_MS = 30 * 60 * 1000;
let captchaUntil = 0;
const PAGE_SIZE = 50;
const MAX_REVIEWS_PER_PRODUCT = 300;

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(value) {
  return normalizeName(value).split(" ").filter(Boolean);
}

function tokensInclude(customer, phrase) {
  if (!phrase.length || phrase.length > customer.length) return false;
  for (let i = 0; i <= customer.length - phrase.length; i += 1) {
    if (phrase.every((token, index) => customer[i + index] === token)) return true;
  }
  return false;
}

/** Poreclă de tip „Octavian.rx”: un nume lung din comandă, plus un sufix scurt. */
function nicknameScore(customer, review, customerSet) {
  const core = review.filter((token) => token.length > 3 || customerSet.has(token));
  const suffixOnly = review.every((token) => customerSet.has(token) || token.length <= 3);
  if (!suffixOnly || !core.length) return 0;
  if (!core.every((token) => customerSet.has(token))) return 0;
  if (!core.some((token) => token.length >= 7)) return 0;
  return 75;
}

/** 100 = nume întreg, 95 = aceleași cuvinte în altă ordine, 75 = poreclă (Octavian.rx), 70+ = prenume + inițială, 25 = doar prenumele. */
function matchScore(customerName, reviewName) {
  const customer = nameTokens(customerName);
  const review = nameTokens(reviewName);
  if (!customer.length || !review.length) return 0;
  if (customer.join(" ") === review.join(" ")) return 100;

  const customerSet = new Set(customer);
  if (
    review.length >= 2
    && review.length === customer.length
    && review.every((token) => customerSet.has(token))
  ) {
    return 95;
  }

  const initial = review.length >= 2 && review[review.length - 1].length === 1
    ? review[review.length - 1]
    : "";
  const given = initial ? review.slice(0, -1) : review;
  if (!tokensInclude(customer, given)) {
    if (review.length === 1 && customer.some((token) => token === review[0] && token.length > 2)) {
      return 25;
    }
    const nickname = nicknameScore(customer, review, customerSet);
    if (nickname) return nickname;
    return 0;
  }
  if (!initial) return given.join(" ") === customer.join(" ") ? 100 : 40;
  const last = customer[customer.length - 1];
  const first = customer[0];
  if (last.startsWith(initial) || first.startsWith(initial)) return 80;
  if (customer.some((token) => token !== given[0] && token.startsWith(initial))) return 70;
  return 0;
}

function parseReviewDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function offerCompatible(product, review) {
  const ours = [product.mkt_id].filter((id) => id != null && id !== "").map(String);
  const theirs = [review.offer_id, review.product_doc_id].filter(Boolean).map(String);
  if (!ours.length || !theirs.length) return true;
  return ours.some((id) => theirs.includes(id));
}

function normalizeReview(item) {
  if (!item || typeof item !== "object") return null;
  if (item.deleted || item.is_active === false) return null;
  const user = item.user && typeof item.user === "object" ? item.user : {};
  const author = String(user.name || user.nickname || user.username || item.author || "").trim();
  const rating = Number(item.rating);
  if (!Number.isFinite(rating)) return null;
  return {
    id: item.id == null ? null : String(item.id),
    rating,
    title: String(item.title || "").trim(),
    content: String(item.content_no_tags || item.content || "").replace(/<[^>]+>/g, "").trim(),
    author,
    created: item.published || item.created || null,
    offer_id: item.offer_id == null ? null : String(item.offer_id),
    product_doc_id: item.product_doc_id == null ? null : String(item.product_doc_id),
    is_bought: item.is_bought !== false && item.is_bought !== 0,
  };
}

function productKey(order, product) {
  return `${order.id}:${product.line_id || product.part_number || product.pnk || ""}`;
}

function assignReviews(orders, reviewsByPnk, { ignoreOffer = false } = {}) {
  for (const order of orders) {
    order.customer_reviews = [];
    for (const product of order.products || []) product.customer_reviews = [];
  }
  const pairs = [];
  for (const order of orders) {
    const orderDate = parseReviewDate(order.date);
    for (const product of order.products || []) {
      const pnk = String(product.pnk || "").trim();
      const reviews = reviewsByPnk.get(pnk) || [];
      for (const review of reviews) {
        if (!review.is_bought) continue;
        if (!ignoreOffer && !offerCompatible(product, review)) continue;
        const reviewDate = parseReviewDate(review.created);
        if (orderDate && reviewDate && reviewDate.getTime() + 12 * 60 * 60 * 1000 < orderDate.getTime()) {
          continue;
        }
        const score = matchScore(order.customer_name, review.author);
        if (score < 70) continue;
        const days = orderDate && reviewDate
          ? Math.max(0, (reviewDate.getTime() - orderDate.getTime()) / 86400000)
          : 0;
        pairs.push({
          order,
          product,
          review,
          score: score - Math.min(days, 90) / 20,
        });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedReviews = new Set();
  const usedSlots = new Set();
  for (const pair of pairs) {
    const reviewKey = pair.review.id || `${pair.product.pnk}:${pair.review.author}:${pair.review.created}`;
    const slot = productKey(pair.order, pair.product);
    if (usedReviews.has(reviewKey) || usedSlots.has(slot)) continue;
    usedReviews.add(reviewKey);
    usedSlots.add(slot);
    if (!pair.product.customer_reviews) pair.product.customer_reviews = [];
    pair.product.customer_reviews.push(publicReview(pair.review));
  }

  for (const order of orders) {
    order.customer_reviews = (order.products || []).flatMap((product) => product.customer_reviews || []);
  }
}

function publicReview(review) {
  return {
    rating: review.rating,
    title: review.title,
    content: review.content,
    created: review.created,
    author: review.author,
  };
}

function reviewsUrl(pnk, offset) {
  const params = new URLSearchParams();
  params.set("page[limit]", String(PAGE_SIZE));
  params.set("page[offset]", String(offset));
  return `https://www.emag.ro/product-feedback/produs/pd/${encodeURIComponent(pnk)}/reviews/list?${params}`;
}

async function fetchReviewPage(pnk, offset) {
  const response = await emagFetch(reviewsUrl(pnk, offset), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Accept-Language": "ro-RO,ro;q=0.9",
      Referer: "https://www.emag.ro/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  const text = await response.text();
  if (response.status === 511 || /eMAG Captcha/i.test(text)) {
    const error = new Error("eMAG a blocat citirea review-urilor");
    error.code = "CAPTCHA";
    throw error;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const error = new Error(`Răspuns review invalid (HTTP ${response.status})`);
    error.code = "BAD_RESPONSE";
    throw error;
  }
  const bag = json.reviews && typeof json.reviews === "object" ? json.reviews : json;
  const items = Array.isArray(bag.items) ? bag.items : Array.isArray(bag.reviews) ? bag.reviews : [];
  const count = Number(bag.count);
  return {
    items: items.map(normalizeReview).filter(Boolean),
    count: Number.isFinite(count) ? count : items.length,
  };
}

async function fetchReviewsForPnk(pnk) {
  const all = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total && all.length < MAX_REVIEWS_PER_PRODUCT) {
    const page = await fetchReviewPage(pnk, offset);
    total = page.count;
    if (!page.items.length) break;
    all.push(...page.items);
    offset += PAGE_SIZE;
    if (page.items.length < PAGE_SIZE) break;
  }
  return all;
}

function cacheIsFresh(row, now) {
  const age = now - new Date(row.fetched_at).getTime();
  if (Number(row.http_status) === 200) return age < CACHE_OK_MS;
  return age < CACHE_FAIL_MS;
}

async function attachCustomerReviews(orders) {
  const pnks = [...new Set(
    orders.flatMap((order) => (order.products || []).map((product) => String(product.pnk || "").trim()))
      .filter((pnk) => /^[A-Z0-9]{6,20}$/i.test(pnk))
  )];
  const reviewsByPnk = new Map();
  if (!pnks.length) return { note: "" };

  const { rows } = await query(
    `SELECT part_number_key, reviews, http_status, fetched_at
     FROM emag_review_cache
     WHERE part_number_key = ANY($1::text[])`,
    [pnks]
  );
  const cached = new Map(rows.map((row) => [row.part_number_key, row]));
  const now = Date.now();
  const missing = [];
  for (const pnk of pnks) {
    const row = cached.get(pnk);
    if (row && cacheIsFresh(row, now)) {
      reviewsByPnk.set(pnk, Array.isArray(row.reviews) ? row.reviews : []);
    } else {
      if (row && Array.isArray(row.reviews) && row.reviews.length) {
        reviewsByPnk.set(pnk, row.reviews);
      }
      missing.push(pnk);
    }
  }

  let blocked = Date.now() < captchaUntil;
  for (const pnk of missing) {
    if (blocked) break;
    try {
      const reviews = await fetchReviewsForPnk(pnk);
      reviewsByPnk.set(pnk, reviews);
      await query(
        `INSERT INTO emag_review_cache (part_number_key, reviews, http_status, fetched_at)
         VALUES ($1, $2::jsonb, 200, now())
         ON CONFLICT (part_number_key) DO UPDATE SET
           reviews = EXCLUDED.reviews,
           http_status = 200,
           fetched_at = now()`,
        [pnk, JSON.stringify(reviews)]
      );
    } catch (err) {
      if (err.code === "CAPTCHA") {
        blocked = true;
        captchaUntil = Date.now() + CACHE_FAIL_MS;
      }
      console.error("[review-calls:reviews]", pnk, err.message);
      await query(
        `INSERT INTO emag_review_cache (part_number_key, reviews, http_status, fetched_at)
         VALUES ($1, '[]'::jsonb, $2, now())
         ON CONFLICT (part_number_key) DO UPDATE SET
           http_status = EXCLUDED.http_status,
           fetched_at = now()`,
        [pnk, err.code === "CAPTCHA" ? 511 : 502]
      );
    }
  }

  assignReviews(orders, reviewsByPnk);
  const anyReviews = [...reviewsByPnk.values()].some((list) => list.length);
  if (anyReviews && !orders.some((order) => (order.customer_reviews || []).length)) {
    assignReviews(orders, reviewsByPnk, { ignoreOffer: true });
  }
  const anyShown = orders.some((order) => (order.customer_reviews || []).length);
  if (blocked && !anyShown) {
    return { note: "Review-urile eMAG nu au putut fi citite acum. Reîncearcă peste câteva minute." };
  }
  return { note: "" };
}

module.exports = {
  attachCustomerReviews,
  assignReviews,
  matchScore,
  normalizeReview,
};
