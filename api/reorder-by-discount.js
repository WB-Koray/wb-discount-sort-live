import { NextResponse } from 'next/server';

const SHOP        = process.env.SHOP;              // *** welcomebaby.myshopify.com ***
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const API_VERSION = process.env.API_VERSION || '2025-10';
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const graphUrl = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

export async function OPTIONS(req) {
  const origin = req.headers.get('origin') || '';
  const allow  = ALLOW_ORIGIN.includes(origin) ? origin : '';
  return new NextResponse(null, { headers: corsHeaders(allow) });
}

export async function POST(req) {
  const origin = req.headers.get('origin') || '';
  if (!ALLOW_ORIGIN.includes(origin)) {
    return NextResponse.json({ ok:false, error:'forbidden origin', origin }, { status: 403, headers: corsHeaders(origin) });
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const collectionId = body.collectionId;

  if (!collectionId) {
    return NextResponse.json({ ok:false, error:'missing collectionId' }, { status: 400, headers: corsHeaders(origin) });
  }

  // 1) Sort order MANUAL
  const setManualMutation = `
    mutation SetManual($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        userErrors { field message }
        collection { id sortOrder }
      }
    }`;

  // 2) Ürünleri indirim oranına göre toplayıp reorder
  const queryProducts = `
    query CollectionProducts($id: ID!) {
      collection(id: $id) {
        id
        products(first: 250) {
          edges {
            node {
              id
              variants(first: 1) {
                nodes {
                  price { amount }
                  compareAtPrice { amount }
                }
              }
            }
          }
        }
      }
    }`;

  const reorderMutation = `
    mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
      collectionReorderProducts(id: $id, moves: $moves) {
        userErrors { field message }
        job { id }
      }
    }`;

  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': ADMIN_TOKEN,
  };

  async function shopify(q, variables) {
    const r = await fetch(graphUrl, { method: 'POST', headers, body: JSON.stringify({ query: q, variables }) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    if (!r.ok) throw { status: r.status, body: j };
    if (j.errors) throw { status: 200, body: j };
    return j.data;
  }

  try {
    // 1) MANUAL
    const upd = await shopify(setManualMutation, { input: { id: collectionId, sortOrder: 'MANUAL' } });

    // 2) ürünleri çek
    const data = await shopify(queryProducts, { id: collectionId });
    const edges = data?.collection?.products?.edges || [];

    // indirim oranı hesapla
    const list = edges.map(e => {
      const id = e.node.id;
      const v  = e.node.variants?.nodes?.[0];
      const price = parseFloat(v?.price?.amount || '0');
      const compare = parseFloat(v?.compareAtPrice?.amount || '0');
      const discount = compare > price && compare > 0 ? (compare - price) / compare : 0;
      return { id, discount };
    });

    // büyükten küçüğe sıralayıp moves oluştur
    const sorted = list.sort((a,b) => b.discount - a.discount).map(i => i.id);
    const moves = sorted.map((gid, idx) => ({ id: gid, newPosition: idx }));

    // 3) reorder
    const r = await shopify(reorderMutation, { id: collectionId, moves });

    return NextResponse.json({ ok: true, setManual: upd, reorder: r }, { headers: corsHeaders(origin) });
  } catch (err) {
    return NextResponse.json(
      { ok:false, error: 'shopify_call_failed', detail: err },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
