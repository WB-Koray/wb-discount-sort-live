const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // ... (Header kısımları aynı) ...
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
        console.log("--- İŞLEM BAŞLIYOR ---");
        
        const productFragment = `
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
        `;

        let graphqlQuery = '';
        if (collectionId) {
            graphqlQuery = `{ node(id: "${collectionId}") { ... on Collection { id sortOrder ${productFragment} } } }`;
        } else if (handle) {
            graphqlQuery = `{ collectionByHandle(handle: "${handle}") { id sortOrder ${productFragment} } }`;
        } else {
            return res.status(400).json({ error: true, message: "Collection ID or Handle required" });
        }

        // 1. Veriyi Çek
        const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
            body: JSON.stringify({ query: graphqlQuery }),
        });

        const json = await response.json();
        if (json.errors) {
            console.error("Shopify Fetch Error:", JSON.stringify(json.errors, null, 2));
            return res.status(500).json({ error: true, message: json.errors });
        }

        const collectionData = json.data.node || json.data.collectionByHandle;
        if (!collectionData) return res.status(404).json({ error: true, message: "Koleksiyon bulunamadı" });

        collectionId = collectionData.id;
        console.log(`Koleksiyon Bulundu: ${collectionId}, Mevcut Sıralama: ${collectionData.sortOrder}`);

        // 2. Manuel Sıralamaya Zorla
        if (collectionData.sortOrder !== 'MANUAL') {
            console.log("Koleksiyon MANUAL değil, güncelleniyor...");
            // ... (Update mutation kodu buraya - kısalttım) ...
            // Burası çalışıyor varsayıyoruz, log kalabalığı yapmasın.
        }

        const rawProducts = collectionData.products.edges;
        console.log(`Toplam Ürün Sayısı: ${rawProducts.length}`);

        // 3. Hesaplama ve LOGLAMA (EN ÖNEMLİ KISIM)
        const products = rawProducts.map(({ node }) => {
            const variantNode = node.variants?.edges?.node;
            
            let price = parseFloat(variantNode?.price || 0);
            let compareAtPrice = parseFloat(variantNode?.compareAtPrice || 0);

            if (!compareAtPrice || compareAtPrice === 0) compareAtPrice = price;

            let discountPercentage = 0;
            if (compareAtPrice > price && compareAtPrice > 0) {
                discountPercentage = Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
            }

            // --- LOG: İlk 3 ürünün detayını görelim ---
            // Bu sayede fiyatları doğru çekiyor muyuz anlarız.
            if (Math.random() < 0.1) { // Rastgele bazı ürünleri logla
                 console.log(`Ürün: ${node.title} | Fiyat: ${price} | Eski Fiyat: ${compareAtPrice} | İndirim: %${discountPercentage}`);
            }

            return { id: node.id, discount: discountPercentage, title: node.title };
        });

        // 4. Sıralama
        const sortedProducts = products.sort((a, b) => b.discount - a.discount);

        console.log("--- SIRALAMA SONRASI İLK 3 ÜRÜN ---");
        console.log(sortedProducts.slice(0, 3));

        // 5. Gönderme
        const moves = sortedProducts.map((product, index) => ({
            id: product.id,
            newPosition: index.toString()
        }));

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
        
        console.log("Shopify Cevabı:", JSON.stringify(reorderJson, null, 2));

        if (reorderJson.data?.collectionReorderProducts?.userErrors?.length > 0) {
            console.error("!!! SHOPIFY HATASI !!!", reorderJson.data.collectionReorderProducts.userErrors);
        }

        res.status(200).json({ ok: true, moved: moves.length, shopifyResponse: reorderJson });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
