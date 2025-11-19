// CORS helper - EN BAŞTA
function setCorsHeaders(res, origin) {
  const allowedOrigins = [
    'https://welcomebaby.com.tr',
    'https://www.welcomebaby.com.tr'
  ];
  
  const isAllowed = allowedOrigins.includes(origin);
  
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : allowedOrigins,[object Object],);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, X-WB-Secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  return res;
}

const API_VERSION = process.env.API_VERSION || "2025-10";
const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_TOKEN;
const SECRET = process.env.WB_SECRET || "";

const graphUrl = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

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
            variants(first: 50) {
              nodes {
                price
                compareAtPrice
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const SET_MANUAL_MUTATION = `
  mutation SetManual($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        sortOrder
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const REORDER_MUTATION = `
  mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function gql(query, variables) {
  const r = await fetch(graphUrl, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(`GraphQL: ${JSON.stringify(j.errors)}`);
  return j.data;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  
  // CORS - HER DURUMDA
  setCorsHeaders(res, origin);

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Sadece POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Env check
    if (!SHOP || !TOKEN) {
      return res.status(500).json({ error: "Missing SHOP / ADMIN_TOKEN" });
    }

    // Secret check
    if (SECRET && req.headers["x-wb-secret"] !== SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Body parse
    let body = req.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const collectionId = body?.collectionId;
    if (!collectionId) {
      return res.status(400).json({ error: "collectionId required" });
    }

    // Set to MANUAL
    const first = await gql(PRODUCTS_QUERY, { id: collectionId, cursor: null });
    
    if (first?.collection?.sortOrder !== "MANUAL") {
      const upd = await gql(SET_MANUAL_MUTATION, {
        input: { id: collectionId, sortOrder: "MANUAL" }
      });
      const errs = upd?.collectionUpdate?.userErrors || [];
      if (errs.length) {
        return res.status(500).json({ ok: false, errors: errs });
      }
    }

    // Fetch all products
    let edges = first?.collection?.products?.edges || [];
    let pageInfo = first?.collection?.products?.pageInfo;
    const items = [];

    const pushEdges = (arr) => {
      for (const e of arr) {
        let maxPct = 0;
        for (const v of e.node?.variants?.nodes || []) {
          const p = Number(v?.price || 0);
          const c = Number(v?.compareAtPrice || 0);
          const pct = c > p ? ((c - p) / c) * 100 : 0;
          if (pct > maxPct) maxPct = pct;
        }
        items.push({ id: e.node.id, discountPercent: maxPct });
      }
    };

    pushEdges(edges);

    while (pageInfo?.hasNextPage) {
      const n = await gql(PRODUCTS_QUERY, {
        id: collectionId,
        cursor: pageInfo.endCursor
      });
      pushEdges(n?.collection?.products?.edges || []);
      pageInfo = n?.collection?.products?.pageInfo;
    }

    if (!items.length) {
      return res.status(200).json({ ok: true, moved: 0 });
    }

    // Sort and reorder
    const moves = items
      .sort((a, b) => b.discountPercent - a.discountPercent)
      .map((p, idx) => ({ id: p.id, newPosition: String(idx + 1) }));

    const result = await gql(REORDER_MUTATION, { id: collectionId, moves });
    const rErrors = result?.collectionReorderProducts?.userErrors || [];
    const jobId = result?.collectionReorderProducts?.job?.id || null;

    return res.status(200).json({
      ok: rErrors.length === 0,
      moved: moves.length,
      errors: rErrors,
      job: jobId
    });

  } catch (e) {
    console.error("API Error:", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
