const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // --- Header Ayarları ---
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
        console.log("--- YENİ STRATEJİ İLE İŞLEM BAŞLIYOR ---");

        // STRATEJİ DEĞİŞİKLİĞİ:
        // Varyant yerine direkt ürünün fiyat aralığını çekiyoruz. Bu çok daha güvenlidir.
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
        const rawProducts = collectionData.products.edges;
        
        console.log(`Toplam Ürün: ${rawProducts.length}`);

        // --- RÖNTGEN MODU: İLK ÜRÜNÜN İÇİNİ GÖRELİM ---
        if (rawProducts.length > 0) {
            console.log("--- İLK ÜRÜNÜN HAM VERİSİ (Bunu bana gönderin) ---");
            console.log(JSON.stringify(rawProducts,node, null, 2));
            console.log("--------------------------------------------------");
        }

        // 2. Hesaplama (PriceRange Kullanarak)
        const products = rawProducts.map(({ node }) => {
            // Fiyatları string'den float'a çeviriyoruz
            let price = parseFloat(node.priceRange?.minVariantPrice?.amount || 0);
            
            // CompareAtPriceRange bazen null gelebilir, kontrol ediyoruz
            let compareAtPrice = 0;
            if (node.compareAtPriceRange && node.compareAtPriceRange.minVariantCompareAtPrice) {
                compareAtPrice = parseFloat(node.compareAtPriceRange.minVariantCompareAtPrice.amount);
            }

            // Eğer eski fiyat yoksa, şu anki fiyata eşitle (İndirim yok demektir)
            if (!compareAtPrice || compareAtPrice === 0) {
                compareAtPrice = price;
            }

            let discountPercentage = 0;
            if (compareAtPrice > price) {
                discountPercentage = Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
            }

            // Log: Rastgele kontrol
            if (Math.random() < 0.05) { 
                 console.log(`Ürün: ${node.title.substring(0, 20)}... | Fiyat: ${price} | Eski: ${compareAtPrice} | İndirim: %${discountPercentage}`);
            }

            return { id: node.id, discount: discountPercentage };
        });

        // 3. Sıralama
        const sortedProducts = products.sort((a, b) => b.discount - a.discount);

        console.log("En Yüksek İndirimli İlk 3 ID:", sortedProducts.slice(0, 3).map(p => p.discount));

        // 4. Gönderme
        const moves = sortedProducts.map((product, index) => ({
            id: product.id,
            newPosition: index.toString()
        }));
        
        // Eğer sıralama değişmeyecekse (hepsi 0 ise) boşuna yorma
        const maxDiscount = sortedProducts, .discount || 0;
        if (maxDiscount === 0) {
            console.log("UYARI: Hiçbir üründe indirim bulunamadı. Sıralama yapılmıyor.");
            return res.status(200).json({ ok: true, message: "İndirimli ürün yok, sıralama değişmedi." });
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
