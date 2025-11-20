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
        // ADIM 1: Ürünleri ve Koleksiyon ID'sini Çek
        // Koleksiyon ID'sini (id) ekledik, çünkü sıralama güncellemek için lazım.
        const productFragment = `
            edges {
                node {
                    id
                    title
                    handle
                    priceRange {
                        minVariantPrice { amount }
                    }
                    compareAtPriceRange {
                        minVariantCompareAtPrice { amount }
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
            graphqlQuery = `{ 
                collectionByHandle(handle: "${handle}") { 
                    id 
                    products(first: 50) { ${productFragment} } 
                } 
            }`;
        } else {
            // Handle yoksa sadece ürünleri listeler, sıralama yapamaz (Koleksiyon ID yok)
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
            return res.status(500).json({ error: true, message: json.errors });
        }

        let rawProducts = [];
        let collectionId = null;

        if (handle) {
            if (!json.data.collectionByHandle) {
                return res.status(404).json({ error: true, message: "Koleksiyon bulunamadı" });
            }
            rawProducts = json.data.collectionByHandle.products.edges;
            collectionId = json.data.collectionByHandle.id;
        } else {
            rawProducts = json.data.products.edges;
        }

        // ADIM 2: İndirimleri Hesapla ve Sırala (RAM'de)
        const products = rawProducts.map(({ node }) => {
            let price = parseFloat(node.priceRange?.minVariantPrice?.amount || 0);
            let compareAtPrice = parseFloat(node.compareAtPriceRange?.minVariantCompareAtPrice?.amount || 0);

            if (price === 0) {
                const variant = node.variants.edges?.node;
                price = parseFloat(variant?.price || 0);
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
                price: price,
                compareAtPrice: compareAtPrice,
                discount: discountPercentage
            };
        });

        // En yüksek indirimden en düşüğe sırala
        const sortedProducts = products.sort((a, b) => b.discount - a.discount);

        // ADIM 3: Shopify'a Yeni Sıralamayı Gönder (Sadece Handle varsa)
        let reorderResult = null;
        
        if (collectionId && sortedProducts.length > 0) {
            // Shopify'ın istediği format: { id: "ProductGID", newPosition: "0" }
            const moves = sortedProducts.map((product, index) => ({
                id: product.id,
                newPosition: index.toString()
            }));

            // Mutation Sorgusu
            const reorderMutation = `
                mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
                    collectionReorderProducts(id: $id, moves: $moves) {
                        job {
                            id
                            done
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `;

            const reorderResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                },
                body: JSON.stringify({
                    query: reorderMutation,
                    variables: {
                        id: collectionId,
                        moves: moves
                    }
                }),
            });

            const reorderJson = await reorderResponse.json();
            reorderResult = reorderJson;
        }

        res.status(200).json({
            success: true,
            collection: handle || "All Products",
            count: sortedProducts.length,
            reorderStatus: reorderResult ? "Sent to Shopify" : "Skipped (No Collection ID)",
            shopifyResponse: reorderResult, // Hata varsa burada görebiliriz
            topDiscounts: sortedProducts.filter(p => p.discount > 0),
            allProducts: sortedProducts
        });

    } catch (error) {
        console.error("Sunucu Hatası:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
