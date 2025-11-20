const fetch = require('node-fetch');

// "export default" YERİNE "module.exports" KULLANIYORUZ:
module.exports = async (req, res) => {

    // CORS Ayarları
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN } = process.env;

    if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({ 
            error: true, 
            message: 'Environment variables missing' 
        });
    }

    try {
        const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({
                query: `
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
                }`
            }),
        });

        const json = await response.json();

        if (json.errors) {
            console.error("Shopify API Hatası:", json.errors);
            return res.status(500).json({ error: true, message: json.errors });
        }

        const products = json.data.products.edges.map(({ node }) => {
            const variant = node.variants.edges,[object Object],?.node;
            const price = parseFloat(variant?.price || 0);
            const compareAtPrice = parseFloat(variant?.compareAtPrice || 0);

            let discountPercentage = 0;
            if (compareAtPrice > price) {
                discountPercentage = Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
            }

            return {
                id: node.id,
                title: node.title,
                handle: node.handle,
                price: price,
                compareAtPrice: compareAtPrice,
                discount: discountPercentage
            };
        });

        const sortedProducts = products.sort((a, b) => b.discount - a.discount);
        const topDiscounts = sortedProducts.filter(p => p.discount > 0);

        res.status(200).json({
            success: true,
            count: sortedProducts.length,
            topDiscounts: topDiscounts,
            allProducts: sortedProducts
        });

    } catch (error) {
        console.error("Sunucu Hatası:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
