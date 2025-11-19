const https = require('https');

// Timeout süresi (30 saniye)
const REQUEST_TIMEOUT = 30000;

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
  
  // Domain formatı kontrolü
  if (domain.includes('http://') || domain.includes('https://') || domain.endsWith('/')) {
    return {
      error: true,
      message: 'Invalid SHOPIFY_DOMAIN format',
      details: {
        current: domain,
        expected: 'your-store.myshopify.com (without https:// or trailing /)'
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
      path: '/admin/api/2024-10/graphql.json', // Güncel API versiyonu
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
      },
      timeout: REQUEST_TIMEOUT
    };

    const req = https.request(options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          
          // Shopify hata kontrolü
          if (res.statusCode !== 200) {
            reject(new Error(`Shopify API returned ${res.statusCode}: ${body}`));
            return;
          }
          
          resolve(json);
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}\nBody: ${body}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${REQUEST_TIMEOUT}ms`));
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
    }
  `;

  console.log('Sending GraphQL request to Shopify...');
  const response = await shopifyGraphQL(query);
  console.log('Received response from Shopify');
  
  if (response.errors) {
    throw new Error(`GraphQL Error: ${JSON.stringify(response.errors)}`);
  }
  
  if (!response.data || !response.data.products) {
    throw new Error(`Invalid response structure: ${JSON.stringify(response)}`);
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

  const startTime = Date.now();

  try {
    // Environment check
    console.log('Checking environment variables...');
    const envCheck = checkEnvironment();
    if (envCheck.error) {
      console.error('Environment check failed:', envCheck);
      return res.status(500).json(envCheck);
    }
    console.log('Environment check passed');

    // Fetch products
    console.log('Fetching products from Shopify...');
    const products = await fetchProducts();
    console.log(`Fetched ${products.length} products`);

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
    const executionTime = Date.now() - startTime;
    console.error('API Error:', error.message);
    console.error('Stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      executionTime: `${executionTime}ms`,
      timestamp: new Date().toISOString(),
      hint: 'Check Vercel Function Logs for details'
    });
  }
};
