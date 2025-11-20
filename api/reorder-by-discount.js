const fetch = require('node-fetch');

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
    const { handle } = req.query;

    if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({ error: true, message: 'Environment variables missing' });
    }

    try {
        // DÜZELTME BURADA YAPILDI: minVariantCompareAtPrice
        const productFragment = `
            edges {
                node {
                    id
                    title
                    handle
                    priceRange {
                        minVariantPrice {
                            amount
                        }
                    }
                    compareAtPriceRange {
                        minVariantCompareAtPrice {
                            amount
                        }
                    }
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
        `;

        let graphqlQuery = '';
        if (handle) {
            graphqlQuery = `{ collectionByHandle(handle: "${handle}") { products(first: 50) { ${productFragment} } } }`;
        } else {
            graphqlQuery = `{ products(first: 50) { ${productFragment} } }`;
        }

        const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({ query: graphqlQuery }),
        });

        const json = await response.json();

        if (json.errors) {
            console.error("API Hatası:", JSON.stringify(json.errors, null, 2));
            return res.status(500).json({ error: true, message: json.errors });
        }

        let rawProducts = [];
        if (handle) {
            if (!json.data.collectionByHandle) {
                return res.status(404).json({ error: true, message: "Koleksiyon bulunamadı" });
            }
            rawProducts = json.data.collectionByHandle.products.edges;
        } else {
            rawProducts = json.data.products.edges;
        }

        const products = rawProducts.map(({ node }) => {
            // 1. Yöntem: Price Range
            let price = parseFloat(node.priceRange?.minVariantPrice?.amount || 0);
            
            // DÜZELTME: Veriyi yeni alandan okuyoruz
            let compareAtPrice = parseFloat(node.compareAtPriceRange?.minVariantCompareAtPrice?.amount || 0);

            // 2. Yöntem: Yedek (Varyant)
            if (price === 0) {
                const variant = node.variants.edges?.node;
                price = parseFloat(variant?.price || 0);
                // Eğer range'den gelmediyse varyanttan almayı dene
                if (compareAtPrice === 0) {
                    compareAtPrice = parseFloat(variant?.compareAtPrice || 0);
                }
            }

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
                discount: discountPercentage,
                debug: {
                    rangePrice: node.priceRange?.minVariantPrice?.amount,
                    rangeCompare: node.compareAtPriceRange?.minVariantCompareAtPrice?.amount
                }
            };
        });

        const sortedProducts = products.sort((a, b) => b.discount - a.discount);
        const topDiscounts = sortedProducts.filter(p => p.discount > 0);

        res.status(200).json({
            success: true,
            collection: handle || "All Products",
            count: sortedProducts.length,
            topDiscounts: topDiscounts,
            allProducts: sortedProducts
        });

    } catch (error) {
        console.error("Sunucu Hatası:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
