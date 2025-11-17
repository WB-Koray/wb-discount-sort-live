// api/reorder-by-discount.js
// Serverless function: Shopify koleksiyon ürünlerini İNDİRİM ORANI'na göre yeniden sıralar.

const API_VERSION   = process.env.API_VERSION || '2025-10';
const SHOP          = process.env.SHOP;               // ör: 59fci5-cd.myshopify.com
const TOKEN         = process.env.ADMIN_TOKEN;        // Admin API Access Token
const SECRET        = process.env.WB_SECRET || '';    // İsteğe bağlı güvenlik anahtarı
const ALLOW_ORIGIN  = (process.env.ALLOW_ORIGIN || 'https://www.welcomebaby.com.tr')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const GRAPHQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

// ---------------------- GraphQL Queries ----------------------
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

// ---------------------- Helpers ----------------------
function setCors(res, origin) {
  res.setHeader('Vary', 'Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Özel header'ı mutlaka izin listesine ekleyelim:
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WB-Secret');
  res.setHeader('Access-Control-Max-Age', '600');
}

async function gql(query, variables) {
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) {
    throw new Error(JSON.stringify(j.errors, null, 2));
  }
  return j.data;
}

async function ensureManual(collectionId) {
  const d = await gql(PRODUCTS_QUERY, { id: collectionId, cursor: null });
  const order = d?.collection?.sortOrder;
  if (order !== 'MANUAL') {
    const u = await gql(SET_MANUAL_MUTATION, { input: { id: collectionId, sortOrder: 'MANUAL' } });
    const errs = u?.collectionUpdate?.userErrors || [];
    if (errs.length) {
      throw new Error(JSON.stringify(errs, null, 2));
    }
  }
}

async function fetchAllProducts(collectionId) {
  let out = [];
  let cursor = null;

  // sayfalama
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const d = await gql(PRODUCTS_QUERY, { id: collectionId, cursor });
    const edges = d?.collection?.products?.edges || [];

    for (const e of edges) {
      let max = 0;
      const variants = e?.node?.variants?.nodes || [];
      for (const v of variants) {
        const p = Number(v?.price || 0);
        const c = Number(v?.compareAtPrice || 0);
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

// ---------------------- Handler ----------------------
export default async function handler(req, res) {
  try {
    const origin = req.headers.origin || '';
    const originAllowed = ALLOW_ORIGIN.includes(origin);

    // CORS
    setCors(res, originAllowed ? origin : '');

    // Preflight
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    // Temel env kontrolleri
    if (!SHOP || !TOKEN) {
      return res.status(500).json({ ok: false, error: 'Missing environment variables (SHOP / ADMIN_TOKEN).' });
    }

    // Origin kontrolü
    if (!originAllowed) {
      return res.status(403).json({ ok: false, error: 'forbidden origin' });
    }

    // Secret kontrolü (SECRET tanımlıysa zorunlu)
    if (SECRET) {
      const incoming = req.headers['x-wb-secret'] || '';
      if (incoming !== SECRET) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    }

    // Body
    const { collectionId } = req.body || {};
    if (!collectionId) {
      return res.status(400).json({ ok: false, error: 'collectionId required' });
    }

    // Koleksiyon MANUAL değilse MANUAL yap
    await ensureManual(collectionId);

    // Ürünleri çek ve indirim yüzdesine göre sırala
    const items = await fetchAllProducts(collectionId);
    if (!items.length) {
      return res.json({ ok: true, moved: 0, job: null });
    }

    const sorted = items.sort((a, b) => b.discountPercent - a.discountPercent);
    const moves = sorted.map((p, i) => ({ id: p.id, newPosition: String(i + 1) }));

    // Reorder
    const data = await gql(REORDER_MUTATION, { id: collectionId, moves });
    const errs = data?.collectionReorderProducts?.userErrors || [];
    if (errs.length) {
      return res.json({ ok: false, errors: errs });
    }

    return res.json({
      ok: true,
      moved: moves.length,
      job: data?.collectionReorderProducts?.job?.id || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
