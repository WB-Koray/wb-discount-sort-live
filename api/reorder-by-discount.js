// ============================================
// CORS Helper Function
// ============================================
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

// ============================================
// Environment Variables
// ============================================
const API_VERSION = process.env.API_VERSION || "2025-10";
const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_TOKEN;
const SECRET = process.env.WB_SECRET || "";

// ============================================
// Shopify GraphQL Endpoint
// ============================================
const graphUrl = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

// ============================================
// GraphQL Queries
// ============================================
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

// ============================================
// GraphQL Helper Function
// ============================================
async function gql(query, variables) {
  try {
    const response = await fetch(graphUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    });
    
    const json = await response.json();
    
    if (json.errors) {
      throw new Error(`GraphQL Error: ${JSON.stringify(json.errors)}`);
    }
    
    return json.data;
  } catch (error) {
    console.error("GraphQL Request Failed:", error);
    throw error;
  }
}

// ============================================
// Main Handler Function
// ============================================
export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  
  setCorsHeaders(res, origin);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!SHOP || !TOKEN) {
      console.error("Missing environment variables:", { SHOP: !!SHOP, TOKEN: !!TOKEN });
      return res.status(500).json({ 
        error: "Server configuration error",
        details: "Missing SHOP or ADMIN_TOKEN environment variables"
      });
    }

    if (SECRET && req.headers["x-wb-secret"] !== SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ error: "Invalid JSON in request body" });
      }
    }

    const collectionId = body?.collectionId;
    if (!collectionId) {
      return res.status(400).json({ error: "collectionId is required" });
    }

    console.log("Processing collection:", collectionId);

    const firstPage = await gql(PRODUCTS_QUERY, { id: collectionId, cursor: null });
    
    if (firstPage?.collection?.sortOrder !== "MANUAL") {
      console.log("Setting collection to MANUAL sort order");
      const updateResult = await gql(SET_MANUAL_MUTATION, {
        input: { id: collectionId, sortOrder: "MANUAL" }
      });
      
      const errors = updateResult?.collectionUpdate?.userErrors || [];
      if (errors.length) {
        console.error("Failed to set MANUAL sort order:", errors);
        return res.status(500).json({ ok: false, errors });
      }
    }

    let edges = firstPage?.collection?.products?.edges || [];
    let pageInfo = firstPage?.collection?.products?.pageInfo;
    const items = [];

    const processEdges = (edgeArray) => {
      for (const edge of edgeArray) {
        let maxDiscountPercent = 0;
        
        for (const variant of edge.node?.variants?.nodes || []) {
          const price = Number(variant?.price || 0);
          const compareAtPrice = Number(variant?.compareAtPrice || 0);
          
          if (compareAtPrice > price) {
            const discountPercent = ((compareAtPrice - price) / compareAtPrice) * 100;
            if (discountPercent > maxDiscountPercent) {
              maxDiscountPercent = discountPercent;
            }
          }
        }
        
        items.push({ 
          id: edge.node.id, 
          discountPercent: maxDiscountPercent 
        });
      }
    };

    processEdges(edges);

    while (pageInfo?.hasNextPage) {
      console.log("Fetching next page...");
      const nextPage = await gql(PRODUCTS_QUERY, {
        id: collectionId,
        cursor: pageInfo.endCursor
      });
      
      const nextEdges = nextPage?.collection?.products?.edges || [];
      processEdges(nextEdges);
      pageInfo = nextPage?.collection?.products?.pageInfo;
    }

    console.log(`Total products found: ${items.length}`);

    if (!items.length) {
      return res.status(200).json({ 
        ok: true, 
        moved: 0,
        message: "No products found in collection"
      });
    }

    const sortedItems = items.sort((a, b) => b.discountPercent - a.discountPercent);
    
    const moves = sortedItems.map((product, index) => ({
      id: product.id,
      newPosition: String(index + 1)
    }));

    console.log(`Reordering ${moves.length} products...`);

    const reorderResult = await gql(REORDER_MUTATION, { 
      id: collectionId, 
      moves 
    });
    
    const reorderErrors = reorderResult?.collectionReorderProducts?.userErrors || [];
    const jobId = reorderResult?.collectionReorderProducts?.job?.id || null;

    if (reorderErrors.length) {
      console.error("Reorder errors:", reorderErrors);
    } else {
      console.log("Reorder successful, job ID:", jobId);
    }

    return res.status(200).json({
      ok: reorderErrors.length === 0,
      moved: moves.length,
      errors: reorderErrors,
      job: jobId
    });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ 
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
}
