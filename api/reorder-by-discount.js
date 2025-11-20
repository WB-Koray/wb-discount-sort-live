const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // 1. CORS Ayarları
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
    
    // URL'den koleksiyon adını (handle) alıyoruz. Örn: ?handle=anne-bebek-urunleri
    const { handle } = req.query;

    if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({ error: true, message: 'Environment variables missing' });
    }

    try {
        // 2. GraphQL Sorgusunu Hazırla
        // Eğer handle varsa o koleksiyonu, yoksa genel ürünleri çeker.
        let graphqlQuery = '';

        if (handle) {
            // Belirli bir koleksiyondaki ürünleri çek
            graphqlQuery = `
            {
                collectionByHandle(handle: "${handle}") {
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
            }`;
        } else {
            // Handle yoksa rastgele 50 ürün çek (Yedek plan)
            graphqlQuery = `
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
            }`;
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

        // Hata kontrolü
        if (json.errors) {
            return res.status(500).json({ error: true, message: json.errors });
        }

        // Veri yolunu ayarla (Koleksiyon sorgusu ile normal sorgunun dönüş yolları farklıdır)
        let rawProducts = [];
        if (handle) {
            if (!json.data.collectionByHandle) {
                return res.status(404).json({ error: true, message: "Koleksiyon bulunamadı" });
            }
            rawProducts = json.data.collectionByHandle.products.edges;
        } else {
            rawProducts = json.data.products.edges;
        }

        // 3. Veriyi İşle
        const products = rawProducts.map(({ node }) => {
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

        // 4. Sırala
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
        console.error("Hata:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
