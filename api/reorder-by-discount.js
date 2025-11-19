// api/reorder-by-discount.js

const fetch = require('node-fetch');

// Shopify API helper fonksiyonu
async function shopifyAPI(endpoint, method = 'GET', body = null) {
  const url = `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`;
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
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

  const response = await shopifyAPI('graphql.json', 'POST', { query });
  return response.data.products.edges;
}

// Ana handler fonksiyonu
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Environment variables kontrolü
    if (!process.env.SHOPIFY_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
      return res.status(500).json({ 
        error: 'Shopify credentials not configured',
        message: 'SHOPIFY_DOMAIN ve SHOPIFY_ACCESS_TOKEN environment variables gerekli'
      });
    }

    console.log('Fetching products...');
    const products = await fetchProducts();

    // İndirim oranlarını hesapla ve sırala
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

    console.log(`Sorted ${productsWithDiscount.length} products`);

    // Sonuçları döndür
    return res.status(200).json({
      success: true,
      count: productsWithDiscount.length,
      products: productsWithDiscount.slice(0, 50), // İlk 50 ürünü göster
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
}
