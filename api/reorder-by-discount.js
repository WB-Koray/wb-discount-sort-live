const https = require('https');

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

  return { error: false };
}

function shopifyGraphQL(query) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query });

    const options = {
      hostname: process.env.SHOPIFY_DOMAIN,
      path: '/admin/api/2024-10/graphql.json',
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

          if (res.statusCode !== 200) {
            reject(new Error(`Shopify API returned ${res.statusCode}: ${body}`));
            return;
          }

          resolve(json);
        } catch (error) {
          reject(new Error(`Failed to parse JSON: ${error.message}`));
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

function calculateDiscount(variant) {
  if (!variant) return 0;

  const price = parseFloat(variant.price || 0);
  const compareAtPrice = parseFloat(variant.compareAtPrice || 0);

  if (!compareAtPrice || compareAtPrice <= price) return 0;

  return ((compareAtPrice - price) / compareAtPrice) * 100;
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

module.exports = async function handler(req, res) {
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
      const variant = product.variants.edges,[object Object],?.node; // Doğru yazım
      
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
    const executionTime = Date.now() - startTime;
    console.error('=== API Error ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);

    return res.status(500).json({
      success: false,
      error: error.message,
      executionTime: `${executionTime}ms`,
      timestamp: new Date().toISOString(),
    });
  }
};
