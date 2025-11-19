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

  console.log('Sending GraphQL request...');
  const response = await shopifyGraphQL(query);
  console.log('Response received');

  if (response.errors) {
    console.error('GraphQL errors:', JSON.stringify(response.errors));
    throw new Error(`GraphQL Error: ${JSON.stringify(response.errors)}`);
  }

  if (!response.data || !response.data.products) {
    console.error('Invalid response:', JSON.stringify(response));
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const startTime = Date.now();

  try {
    console.log('=== API Request Started ===');
    
    const envCheck = checkEnvironment();
    if (envCheck.error) {
      console.error('Environment check failed:', envCheck);
      return res.status(500).json(envCheck);
    }
    console.log('✓ Environment check passed');

    const products = await fetchProducts();
    console.log(`✓ Fetched ${products.length} products`);

    const productsWithDiscount = products.map(edge => {
      const product = edge.node;
      const variant = product.variants.edges,[object Object],?.node;
      
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

    const executionTime = Date.now() - startTime;
    console.log(`✓ Completed in ${executionTime}ms`);

    return res.status(200).json({
      success: true,
      count: productsWithDiscount.length,
      topDiscounts: productsWithDiscount.filter(p => p.discount > 0).slice(0, 10),
      allProducts: productsWithDiscount,
      executionTime: `${executionTime}ms`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};
