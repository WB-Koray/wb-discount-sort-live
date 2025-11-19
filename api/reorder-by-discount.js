// api/reorder-by-discount.js

const fetch = require('node-fetch');

// Environment variables kontrolü
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

// Shopify GraphQL API çağrısı
async function shopifyGraphQL(query) {
  const url = `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Shopify API Error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

// İndirim oranını hesapla
function calculateDiscount(product) {
  const variant = product.variants.edges,[object Object],?.node;
  if (!variant) return 0;

  const price = parseFloat(variant.price);
  const compareAtPrice = parseFloat(variant.compareAtPrice);

  if (!compareAtPrice || compareAtPrice <= price) return 0;

  return ((compareAtPrice - price) / compareAtPrice) * 100;
}

// Ürünleri çek
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

// Ana handler fonksiyonu
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Environment variables kontrolü
    const envCheck = checkEnvironment();
    if (envCheck.error) {
      return res.status(500).json(envCheck);
    }

    console.log('Fetching products from Shopify...');
    const products = await fetchProducts();

    // İndirim oranlarını hesapla
    const productsWithDiscount = products.map(({ node }) => ({
      id: node.id,
      title: node.title,
      handle: node.handle,
      discount: calculateDiscount(node),
      price: node.variants.edges,[object Object],?.node.price,
      compareAtPrice: node.variants.edges,[object Object],?.node.compareAtPrice,
    }));

    // İndirim oranına göre azalan sırada sırala
    productsWithDiscount.sort((a, b) => b.discount - a.discount);

    console.log(`✓ Sorted ${productsWithDiscount.length} products`);

    // Sonuçları döndür
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
    });
  }
};
