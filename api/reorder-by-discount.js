const fetch = require('node-fetch');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-wb-secret');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const { SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN } = process.env;
    let collectionId = req.body?.collectionId || req.query?.id;
    const handle = req.query?.handle;

    if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({ error: true, message: 'Environment variables missing' });
    }

    try {
        console.log("--- AKILLI FİYAT DÜZELTİCİ MODU ---");

        const productFragment = `
        products(first: 250) {
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
                }
            }
        }
        `;

        let graphqlQuery = '';
        if (collectionId) {
            graphqlQuery = `{ node(id: "${collectionId}") { ... on Collection { id sortOrder ${productFragment} } } }`;
        } else if (handle) {
            graphqlQuery = `{ collectionByHandle(handle: "${handle}") { id sortOrder ${productFragment} } }`;
        } else {
            return res.status(400).json({ error: true, message: "Collection ID or Handle required" });
        }

        const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
            body: JSON.stringify({ query: graphqlQuery }),
        });

        const json = await response.json();
        if (json.errors) return res.status(500).json({ error: true, message: json.errors });

        const collectionData = json.data.node || json.data.collectionByHandle;
        if (!collectionData) return res.status(404).json({ error: true, message: "Koleksiyon bulunamadı" });

        collectionId = collectionData.id;
        const rawProducts = collectionData.products.edges;
        
        console.log(`Toplam Ürün: ${rawProducts.length}`);

        const products = rawProducts.map(({ node }) => {
            let price = parseFloat(node.priceRange?.minVariantPrice?.amount || 0);
            
            let compareAtPrice = 0;
            if (node.compareAtPriceRange && node.compareAtPriceRange.minVariantCompareAtPrice) {
                compareAtPrice = parseFloat(node.compareAtPriceRange.minVariantCompareAtPrice.amount);
            }

            // --- AKILLI DÜZELTME MANTIĞI ---
            // Sorun: Price 134900.0 geliyor, CompareAt 1799.9 geliyor.
            // Çözüm: Eğer Price, CompareAt'ten çok büyükse (örneğin 10 katından fazla), 
            // ve Price'ı 100'e böldüğümüzde CompareAt'in altına düşüyorsa, bu bir format hatasıdır.
            
            if (compareAtPrice > 0 && price > compareAtPrice * 2) {
                const correctedPrice = price / 100;
                
                // Eğer 100'e bölünmüş hali mantıklıysa (Eski fiyattan düşükse veya yakınsa) onu kullan
                if (correctedPrice < compareAtPrice) {
                    // Sadece emin olmak için loglayalım (ilk birkaç seferde)
                    if (Math.random() < 0.05) {
                        console.log(`DÜZELTME: ${node.title} | Hatalı Fiyat: ${price} -> Düzeltilen: ${correctedPrice} | Eski Fiyat: ${compareAtPrice}`);
                    }
                    price = correctedPrice;
                }
            }

            if (!compareAtPrice || compareAtPrice === 0) {
                compareAtPrice = price;
            }

            let discountPercentage = 0;
            if (compareAtPrice > price) {
                discountPercentage = Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
            }

            return { id: node.id, discount: discountPercentage };
        });

        const sortedProducts = products.sort((a, b) => b.discount - a.discount);

        // Kontrol için en yüksek indirimleri yazdıralım
        console.log("En Yüksek 5 İndirim:", sortedProducts.slice(0, 5).map(p => `%${p.discount}`));

        const moves = sortedProducts.map((product, index) => ({
            id: product.id,
            newPosition: index.toString()
        }));
        
        const maxDiscount = sortedProducts?.discount || 0;
        if (maxDiscount === 0) {
            console.log("UYARI: İndirim bulunamadı (Düzeltmeye rağmen).");
            return res.status(200).json({ ok: true, message: "İndirimli ürün yok." });
        }

        const reorderMutation = `
        mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
            collectionReorderProducts(id: $id, moves: $moves) {
                job { id done }
                userErrors { field message }
            }
        }
        `;

        const reorderResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
            body: JSON.stringify({ query: reorderMutation, variables: { id: collectionId, moves: moves } }),
        });

        const reorderJson = await reorderResponse.json();
        res.status(200).json({ ok: true, moved: moves.length, shopifyResponse: reorderJson });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
