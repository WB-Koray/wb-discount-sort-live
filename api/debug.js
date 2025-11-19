// api/debug.js

module.exports = async function handler(req, res) {
  return res.status(200).json({
    status: 'API is working!',
    timestamp: new Date().toISOString(),
    env: {
      SHOPIFY_DOMAIN: process.env.SHOPIFY_DOMAIN ? '✓ Set' : '✗ Missing',
      SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN ? '✓ Set (hidden)' : '✗ Missing',
      NODE_ENV: process.env.NODE_ENV,
    },
    vercel: {
      region: process.env.VERCEL_REGION || 'unknown',
      env: process.env.VERCEL_ENV || 'unknown',
    }
  });
};
