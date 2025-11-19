const API_VERSION = process.env.API_VERSION || "2025-10";
const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_TOKEN;
const SECRET = process.env.WB_SECRET || "";
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

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
  // CORS - Her durumda set et
  const origin = req.headers.origin || "";
  const allowedOrigins = ALLOW_ORIGIN.length 
    ? ALLOW_ORIGIN 
    : ["https://welcomebaby.com.tr", "https://www.welcomebaby.com.tr"];
  
  const isAllowed = allowedOrigins.some(o => o === origin) || !ALLOW_ORIGIN.length;
  
  // CORS Headers
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", isAllowed ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-WB-Secret, X-Requested-With, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Sadece POST kabul et
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // Env kontrolleri
    if (!SHOP || !TOKEN) {
      res.status(500).json({ error: "Missing SHOP / ADMIN_TOKEN" });
      return;
    }

    // Secret kontrolü
    if (SECRET && req.headers["x-wb-secret"] !== SECRET) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Body parse
    let body;
    if (typeof req.body === "string") {
      body = JSON.parse(req.body);
    } else if (typeof req.body === "object") {
      body = req.body;
    } else {
      // Manuel parse
      body = await new Promise((resolve) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => resolve(JSON.parse(data || "{}")));
      });
    }

    const collectionId = body.collectionId;

    if (!collectionId) {
      res.status(400).json({ error: "collectionId required" });
      return;
    }

    // Koleksiyonu MANUAL yap
    const first = await gql(PRODUCTS_QUERY, { id: collectionId, cursor: null });
    
    if (first?.collection?.sortOrder !== "MANUAL") {
      const upd = await gql(SET_MANUAL_MUTATION, {
        input: { id: collectionId, sortOrder: "MANUAL" }
      });
      const errs = upd?.collectionUpdate?.userErrors || [];
      if (errs.length) {
        res.status(500).json({ ok: false, errors: errs });
        return;
      }
    }

    // Tüm ürünleri çek
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
      res.status(200).json({ ok: true, moved: 0 });
      return;
    }

    // Sırala ve reorder
    const moves = items
      .sort((a, b) => b.discountPercent - a.discountPercent)
      .map((p, idx) => ({ id: p.id, newPosition: String(idx + 1) }));

    const result = await gql(REORDER_MUTATION, { id: collectionId, moves });
    const rErrors = result?.collectionReorderProducts?.userErrors || [];
    const jobId = result?.collectionReorderProducts?.job?.id || null;

    res.status(200).json({
      ok: rErrors.length === 0,
      moved: moves.length,
      errors: rErrors,
      job: jobId
    });

  } catch (e) {
    console.error("API Error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}
