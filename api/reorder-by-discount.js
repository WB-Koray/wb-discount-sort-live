// app/api/reorder-by-discount/route.js
import { NextResponse } from 'next/server';

const SHOP = process.env.SHOP;                    // welcomebaby.com.tr (subdomain yok)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const API_VERSION = process.env.API_VERSION || '2025-10';
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean); // "https://welcomebaby.com.tr, https://www.welcomebaby.com.tr" gibi virgüllü değer OK

const graphUrl = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

export async function OPTIONS(req) {
  const origin = req.headers.get('origin') || '';
  const allow = ALLOW_ORIGIN.includes(origin) ? origin : '';
  return new NextResponse(null, { headers: corsHeaders(allow) });
}

export async function POST(req) {
  const origin = req.headers.get('origin') || '';
  if (!ALLOW_ORIGIN.includes(origin)) {
    return new NextResponse('forbidden origin', { status: 403, headers: corsHeaders(origin) });
  }

  try {
    const { collectionId } = await req.json();
    if (!collectionId) {
      return new NextResponse(JSON.stringify({ error: 'collectionId missing' }), {
        status: 400, headers: corsHeaders(origin)
      });
    }

    // 1) koleksiyon ürünlerini al
    const PRODUCTS_QUERY = `
      query CollectionProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          id
          products(first: 250, after: $cursor) {
            edges {
              cursor
              node {
                id
                title
                variants(first: 1) {
                  nodes {
                    price
                    compareAtPrice
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;

    async function gql(query, variables) {
      const res = await fetch(graphUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      return json.data;
    }

    async function fetchAllProducts(collId) {
      let items = [];
      let cursor = null;
      while (true) {
        const data = await gql(PRODUCTS_QUERY, { id: collId, cursor });
        const edges = data?.collection?.products?.edges || [];
        for (const e of edges) {
          const n = e.node;
          const v = n?.variants?.nodes?.[0] || {};
          const price = Number(v.price || 0);
          const cmp = Number(v.compareAtPrice || 0);
          const discount = (cmp > price && cmp > 0) ? ((cmp - price) / cmp) * 100 : 0;
          items.push({ id: n.id, discount });
        }
        const pi = data?.collection?.products?.pageInfo;
        if (!pi?.hasNextPage) break;
        cursor = pi.endCursor;
      }
      return items;
    }

    const products = await fetchAllProducts(collectionId);
    if (!products.length) {
      return new NextResponse(JSON.stringify({ ok: true, message: 'empty collection' }), {
        status: 200, headers: corsHeaders(origin)
      });
    }

    // 2) indirime göre DESC sırala ve move listesi hazırla
    const sorted = products.slice().sort((a, b) => b.discount - a.discount);
    const moves = sorted.map((p, i) => ({ id: p.id, newPosition: String(i + 1) }));

    // 3) reorderinghttps://github.com/WB-Koray/wb-discount-sort-live/blob/main/api/reorder-by-discount.js
    const REORDER_MUTATION = `
      mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          job { id }
          userErrors { field message }
        }
      }`;

    const data = await gql(REORDER_MUTATION, { id: collectionId, moves });
    const errs = data?.collectionReorderProducts?.userErrors || [];
    if (errs.length) {
      return new NextResponse(JSON.stringify({ ok: false, errors: errs }), {
        status: 200, headers: corsHeaders(origin)
      });
    }

    return new NextResponse(JSON.stringify({
      ok: true,
      jobId: data?.collectionReorderProducts?.job?.id || null,
      moved: moves.length
    }), { status: 200, headers: corsHeaders(origin) });

  } catch (e) {
    return new NextResponse(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: corsHeaders(ALLOW_ORIGIN[0] || '*')
    });
  }
}
