const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // CORS Ayarları
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
        console.log("--- SINIRSIZ ÜRÜN TARAMA MODU ---");

        // Koleksiyon ID'sini bulmak için ilk sorgu (Sadece ID ve SortOrder alıyoruz başta)
        let initialQuery = '';
        if (collectionId) {
            initialQuery = `{ node(id: "${collectionId}") { ... on Collection { id } } }`;
        } else if (handle) {
            initialQuery = `{ collectionByHandle(handle: "${handle}") { id } }`;
        } else {
            return res.status(400).json({ error: true, message: "Collection ID or Handle required" });
        }

        const initResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
            body: JSON.stringify({ query: initialQuery }),
        });
        const initJson = await initResponse.json();
        const collectionData = initJson.data?.node || initJson.data?.collectionByHandle;
        
        if (!collectionData) return res.status(404).json({ error: true, message: "Koleksiyon bulunamadı" });
        collectionId = collectionData.id;

        // --- TÜM ÜRÜNLERİ DÖNGÜ İLE ÇEKME ---
        let allProducts = [];
        let hasNextPage = true;
        let endCursor = null;

        console.log("Ürünler çekiliyor...");

        while (hasNextPage) {
            const queryParams = endCursor ? `first: 250, after: "${endCursor}"` : `first: 250`;
            
            const productsQuery = `
            {
                node(id: "${collectionId}") {
                    ... on Collection {
                        products(${queryParams}) {
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                            edges {
                                node {
                                    id
                                    title
                                    priceRange { minVariantPrice { amount } }
                                    compareAtPriceRange { minVariantCompareAtPrice { amount } }
                                }
                            }
                        }
                    }
                }
            }`;

            const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
                body: JSON.stringify({ query: productsQuery }),
            });

            const json = await response.json();
            if (json.errors) throw new Error(JSON.stringify(json.errors));

            const productData = json.data.node.products;
            allProducts = allProducts.concat(productData.edges);
            
            hasNextPage = productData.pageInfo.hasNextPage;
            endCursor = productData.pageInfo.endCursor;
            
            console.log(`Şu ana kadar çekilen ürün sayısı: ${allProducts.length}`);
        }

        console.log(`TARAMA TAMAMLANDI. Toplam ${allProducts.length} ürün işleniyor.`);

        // --- HESAPLAMA VE SIRALAMA ---
        const processedProducts = allProducts.map(({ node }) => {
            let price = parseFloat(node.priceRange?.minVariantPrice?.amount || 0);
            let compareAtPrice = 0;
            
            if (node.compareAtPriceRange && node.compareAtPriceRange.minVariantCompareAtPrice) {
                compareAtPrice = parseFloat(node.compareAtPriceRange.minVariantCompareAtPrice.amount);
            }

            // Akıllı Fiyat Düzeltme
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

        // İndirime göre sırala (Büyükten küçüğe)
        processedProducts.sort((a, b) => b.discount - a.discount);

        // --- MOVES OLUŞTURMA ---
        // Çok fazla ürün varsa Shopify API tek seferde hepsini kabul etmeyebilir.
        // Ancak genellikle 2000-3000 ürünlük 'moves' array'i sorun çıkarmaz.
        // Eğer timeout alırsanız bu kısmı parçalara bölmek gerekir.
        
        const moves = processedProducts.map((product, index) => ({
            id: product.id,
            newPosition: index.toString()
        }));

        console.log(`Shopify'a ${moves.length} adet sıralama komutu gönderiliyor...`);

        // Mutation sorgusu
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
        }

        res.status(200).json({ 
            ok: true, 
            totalProcessed: allProducts.length, 
            shopifyResponse: reorderJson 
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
