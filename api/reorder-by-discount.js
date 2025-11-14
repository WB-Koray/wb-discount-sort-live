const API_VERSION = process.env.API_VERSION || "2025-10";
const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_TOKEN;
const SECRET = process.env.WB_SECRET;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "https://www.welcomebaby.com.tr";
const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

const PRODUCTS_QUERY = `
query CollectionProducts($id: ID!, $cursor: String) {
  collection(id: $id) {
    id
    sortOrder
    products(first: 250, after: $cursor) {
      edges {
        cursor
        node {
          id
          title
          variants(first: 50) {
            nodes { price compareAtPrice }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
`;
const SET_MANUAL_MUTATION = `
mutation SetManual($input: CollectionInput!) {
  collectionUpdate(input: $input) {
    collection { id sortOrder }
    userErrors { field message }
  }
}
`;
const REORDER_MUTATION = `
mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
  collectionReorderProducts(id: $id, moves: $moves) {
    job { id }
    userErrors { field message }
  }
}
`;

async function gql(query, variables) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors, null, 2));
  return j.data;
}
async function ensureManual(id) {
  const d = await gql(PRODUCTS_QUERY, { id, cursor: null });
  if (d?.collection?.sortOrder !== "MANUAL") {
    const u = await gql(SET_MANUAL_MUTATION, { input: { id, sortOrder: "MANUAL" } });
    const errs = u?.collectionUpdate?.userErrors || [];
    if (errs.length) throw new Error(JSON.stringify(errs, null, 2));
  }
}
async function fetchAllProducts(id) {
  let out = [], cursor = null;
  for (;;) {
    const d = await gql(PRODUCTS_QUERY, { id, cursor });
    for (const e of d?.collection?.products?.edges || []) {
      let max = 0;
      for (const v of e.node?.variants?.nodes || []) {
        const p = Number(v?.price || 0), c = Number(v?.compareAtPrice || 0);
        const pct = c > p ? ((c - p) / c) * 100 : 0;
        if (pct > max) max = pct;
      }
      out.push({ id: e.node.id, discountPercent: max });
    }
    const pi = d?.collection?.products?.pageInfo;
    if (!pi?.hasNextPage) break;
    cursor = pi.endCursor;
  }
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Vary", "Origin");
    const origin = req.headers.origin || "";
    if (origin === ALLOW_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-WB-Secret");
    }
    if (req.method === "OPTIONS") return res.status(204).end();

    if (!SHOP || !TOKEN) return res.status(500).json({ error: "Env missing" });
    if (!SECRET || req.headers["x-wb-secret"] !== SECRET)
      return res.status(401).json({ error: "Unauthorized" });

    const { collectionId } = req.body || {};
    if (!collectionId) return res.status(400).json({ error: "collectionId required" });

    await ensureManual(collectionId);
    const products = await fetchAllProducts(collectionId);
    if (!products.length) return res.json({ ok: true, moved: 0, job: null });

    const sorted = products.sort((a, b) => b.discountPercent - a.discountPercent);
    const moves = sorted.map((p, i) => ({ id: p.id, newPosition: String(i + 1) }));

    const data = await gql(REORDER_MUTATION, { id: collectionId, moves });
    const errs = data?.collectionReorderProducts?.userErrors || [];
    if (errs.length) return res.json({ ok: false, errors: errs });

    return res.json({ ok: true, moved: moves.length, job: data?.collectionReorderProducts?.job?.id || null });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
