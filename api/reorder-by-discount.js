const fetch = require('node-fetch');

function checkEnvironment() {
  const required = ['SHOPIFY_STORE_URL', 'SHOPIFY_ACCESS_TOKEN'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    return { error: true, missing };
  }
  return { error: false };
}

async function shopifyGraphQL(query) {
  const url = `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

async function fetchProducts() {
  const query = `{
    products(first: 50) {
      edges {
        node {
          id
          title
          handle
          variants(first: 1) {
            edges {
              node {
                price
                compareAtPrice
              }
            }
          }
        }
      }
    }
  }`;

  const response = await shopifyGraphQL(query);

  if (response.errors) {
    throw new Error(`GraphQL Error: ${JSON.stringify(response.errors)}`);
  }

  if (!response.data || !response.data.products) {
    throw new Error('Invalid response structure from Shopify');
  }

  return response.data.products.edges;
}

function calculateDiscount(variant) {
  if (!variant || !variant.compareAtPrice || !variant.price) {
    return 0;
  }

  const price = parseFloat(variant.price);
  const compareAtPrice = parseFloat(variant.compareAtPrice);

  if (compareAtPrice <= price) {
    return 0;
  }

  return ((compareAtPrice - price) / compareAtPrice) * 100;
}

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const envCheck = checkEnvironment();
    if (envCheck.error) {
      console.error('Environment missing:', envCheck);
      return res.status(500).json(envCheck);
    }

    const products = await fetchProducts();
    
    // HATA VEREN KISIM BURADAYDI - DUZELTILMIS HALI:
    const productsWithDiscount = products.map(edge => {
      const product = edge.node;
      // DİKKAT: Burada sadece ,[object Object], olmalı
      const variant = product.variants.edges?.node;
      
      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        discount: calculateDiscount(variant),
        price: variant?.price || '0',
        compareAtPrice: variant?.compareAtPrice || '0',
      };
    });

    productsWithDiscount.sort((a, b) => b.discount - a.discount);

    return res.status(200).json({
      success: true,
      count: productsWithDiscount.length,
      topDiscounts: productsWithDiscount.filter(p => p.discount > 0).slice(0, 10),
      allProducts: productsWithDiscount
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
