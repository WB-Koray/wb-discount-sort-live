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
        console.log("--- AKILLI SIRALAMA (OTOMATİK MANUEL MOD) ---");

        const productFragment = `
        products(first: 250) {
            edges {
                node {
                    id
                    title
                    handle
                    priceRange { minVariantPrice { amount } }
                    compareAtPriceRange { minVariantCompareAtPrice { amount } }
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
        const currentSortOrder = collectionData.sortOrder; // Mevcut sıralama ayarını al
        const rawProducts = collectionData.products.edges;
        
        console.log(`Koleksiyon: ${collectionId} | Mevcut Mod: ${currentSortOrder} | Ürün: ${rawProducts.length}`);

        // --- ADIM 1: EĞER KOLEKSİYON "MANUAL" DEĞİLSE, ÖNCE ONU DÜZELT ---
        if (currentSortOrder !== 'MANUAL') {
            console.log("Koleksiyon manuel modda değil, değiştiriliyor...");
            
            const updateCollectionMutation = `
            mutation collectionUpdate($input: CollectionInput!) {
                collectionUpdate(input: $input) {
                    collection { sortOrder }
                    userErrors { field message }
                }
            }
            `;

            await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
                body: JSON.stringify({ 
                    query: updateCollectionMutation, 
                    variables: { input: { id: collectionId, sortOrder: "MANUAL" } } 
                }),
            });
            console.log("Koleksiyon MANUAL moda alındı.");
        }

        // --- ADIM 2: İNDİRİM HESAPLAMA ---
        const products = rawProducts.map(({ node }) => {
            let price = parseFloat(node.priceRange?.minVariantPrice?.amount || 0);
            let compareAtPrice = 0;
            if (node.compareAtPriceRange && node.compareAtPriceRange.minVariantCompareAtPrice) {
                compareAtPrice = parseFloat(node.compareAtPriceRange.minVariantCompareAtPrice.amount);
            }

            // Fiyat düzeltme (134900 hatası için)
            if (compareAtPrice > 0 && price > compareAtPrice * 2) {
                const correctedPrice = price / 100;
                if (correctedPrice < compareAtPrice) price = correctedPrice;
            }

            if (!compareAtPrice || compareAtPrice === 0) compareAtPrice = price;

            let discountPercentage = 0;
            if (compareAtPrice > price) {
                discountPercentage = Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
            }

            return { id: node.id, discount: discountPercentage };
        });

        // Sıralama (Büyükten küçüğe)
        const sortedProducts = products.sort((a, b) => b.discount - a.discount);

        // --- ADIM 3: YENİ SIRALAMAYI GÖNDER ---
        const moves = sortedProducts.map((product, index) => ({
            id: product.id,
            newPosition: index.toString()
        }));

        console.log(`Sıralama gönderiliyor (${moves.length} ürün)...`);

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
        
        if (reorderJson.data?.collectionReorderProducts?.userErrors?.length > 0) {
            console.error("HATA:", reorderJson.data.collectionReorderProducts.userErrors);
        } else {
            console.log("İşlem Başarılı!");
        }

        res.status(200).json({ ok: true, moved: moves.length, shopifyResponse: reorderJson });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
