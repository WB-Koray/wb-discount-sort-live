// api/reorder-by-discount.js  (Vercel Node.js Serverless Function)

const SHOP = process.env.SHOP;                 // xxx.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;   // Admin API token
const API_VERSION = process.env.API_VERSION || '2025-10';
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean); // "https://welcomebaby.com.tr,https://www.welcomebaby.com.tr"

const graphUrl = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allow = ALLOW_ORIGIN.includes(origin) ? origin : '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCors(res, allow);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    setCors(res, allow);
    res.statusCode = 405;
    res.json({ error: 'method_not_allowed' });
    return;
  }

  if (!allow) {
    setCors(res, '');
    res.statusCode = 403;
    res.json({ error: 'forbidden_origin', origin });
    return;
  }

  try {
    // body: { collectionId: 'gid://shopify/Collection/xxxx' }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const collectionId = body.collectionId;

    if (!collectionId) {
      setCors(res, allow);
      res.statusCode = 400;
      res.json({ error: 'missing_collectionId' });
      return;
    }

    // 1) Koleksiyondaki ürünleri çek
    const QUERY = `
      query CollectionProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          id
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                variants(first: 1) {
                  nodes {
                    price       # Money gibi scalar; amount seçimi yok!
                    compareAtPrice
                  }
                }
              }
            }
          }
        }
      }`;

    const products = [];
    let cursor = null;

    while (true) {
      const qRes = await fetch(graphUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: QUERY, variables: { id: collectionId, cursor } }),
      });
      const qJson = await qRes.json();

      if (qRes.status !== 200 || qJson.errors) {
        setCors(res, allow);
        res.statusCode = 500;
        res.json({ error: 'shopify_query_failed', detail: qJson.errors || qJson });
        return;
      }

      const list = qJson.data?.collection?.products?.edges || [];
      for (const e of list) {
        const v = e.node.variants?.nodes?.[0];
        const price = v?.price ? Number(v.price) : NaN;
        const compare = v?.compareAtPrice ? Number(v.compareAtPrice) : NaN;
        // indirim oranı (compare varsa)
        const discount = Number.isFinite(compare) && compare > 0 && Number.isFinite(price)
          ? Math.max(0, ((compare - price) / compare))
          : 0;
        products.push({ id: e.node.id, discount });
      }

      const pageInfo = qJson.data?.collection?.products?.pageInfo;
      if (pageInfo?.hasNextPage) {
        cursor = pageInfo.endCursor;
      } else {
        break;
      }
    }

    // 2) İndirime göre büyükten küçüğe sırala
    products.sort((a, b) => b.discount - a.discount);

    // 3) Reorder hareketlerini hazırla
    const MOVES = [];
    for (let i = 0; i < products.length; i++) {
      MOVES.push({
        id: products[i].id,
        newPosition: `${i + 1}`,
      });
    }

    // 4) Shopify’a reorder isteği
    const MUTATION = `
      mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          job { id }
          userErrors { field message }
        }
      }`;

    const mRes = await fetch(graphUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: MUTATION, variables: { id: collectionId, moves: MOVES } }),
    });
    const mJson = await mRes.json();

    setCors(res, allow);

    if (mJson.data?.collectionReorderProducts?.userErrors?.length) {
      res.statusCode = 422;
      res.json({ ok: false, userErrors: mJson.data.collectionReorderProducts.userErrors });
      return;
    }

    res.statusCode = 200;
    res.json({
      ok: true,
      count: products.length,
      jobId: mJson.data?.collectionReorderProducts?.job?.id || null,
    });
  } catch (err) {
    setCors(res, allow);
    res.statusCode = 500;
    res.json({ error: 'internal_error', detail: String(err && err.stack || err) });
  }
}
