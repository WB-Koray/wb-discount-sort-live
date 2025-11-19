// Node.js built-in https modülünü kullanacağız (node-fetch yerine)
const https = require('https');

function checkEnvironment() {
  const domain = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!domain || !token) {
    return {
      error: true,
      message: 'Missing environment variables',
      details: {
        SHOPIFY_DOMAIN: domain ? '✓ Set' : '✗ Missing',
        SHOPIFY_ACCESS_TOKEN: token ? '✓ Set' : '✗ Missing'
      }
    };
  }
  
  return { error: false };
}

function shopifyGraphQL(query) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query });
    
    const options = {
      hostname: process.env.SHOPIFY_DOMAIN,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

function calculateDiscount(product) {
  const variant = product.variants.edges,[object Object],?.node;
  if (!variant) return 0;

  const price = parseFloat(variant.price);
  const compareAtPrice = parseFloat(variant.compareAtPrice);

  if (!compareAtPrice || compareAtPrice <= price) return 0;

  return ((compareAtPrice - price) / compareAtPrice) * 100;
}

async function fetchProducts() {
  const query = `
    {
      products(first: 250) {
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
    }
  `;

  const response = await shopifyGraphQL(query);
  
  if (response.errors) {
    throw new Error(`GraphQL Error: ${JSON.stringify(response.errors)}`);
  }
  
  return response.data.products.edges;
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Environment check
    const envCheck = checkEnvironment();
    if (envCheck.error) {
      return res.status(500).json(envCheck);
    }

    console.log('Fetching products from Shopify...');
    const products = await fetchProducts();

    // Calculate discounts
    const productsWithDiscount = products.map(({ node }) => ({
      id: node.id,
      title: node.title,
      handle: node.handle,
      discount: calculateDiscount(node),
      price: node.variants.edges,[object Object],?.node.price,
      compareAtPrice: node.variants.edges,[object Object],?.node.compareAtPrice,
    }));

    // Sort by discount (highest first)
    productsWithDiscount.sort((a, b) => b.discount - a.discount);

    console.log(`✓ Sorted ${productsWithDiscount.length} products`);

    return res.status(200).json({
      success: true,
      count: productsWithDiscount.length,
      topDiscounts: productsWithDiscount.filter(p => p.discount > 0).slice(0, 10),
      allProducts: productsWithDiscount,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });
  }
};
