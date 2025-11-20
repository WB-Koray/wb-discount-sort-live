const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // 1. CORS ve Pre-flight Ayarları
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-wb-secret'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN } = process.env;
    let collectionId = req.body?.collectionId || req.query?.id;
    const handle = req.query?.handle;

    if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({ error: true, message: 'Environment variables missing' });
    }

    try {
        // Ürün verilerini çekeceğimiz parça
        // Not: Varyantlardan fiyatı ve compareAtPrice'ı net istiyoruz.
        const productFragment = `
        products(first: 250) {
            edges {
                node {
                    id
                    title
                    priceRange { minVariantPrice { amount } }
                    compareAtPriceRange { minVariantCompareAtPrice { amount } }
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

        // Senaryo A: Frontend GID gönderdi
        if (collectionId) {
            graphqlQuery = `
            {
                node(id: "${collectionId}") {
                    ... on Collection {
                        id
                        sortOrder
                        ${productFragment}
                    }
                }
            }
            `;
        }
        // Senaryo B: Handle gönderildi
        else if (handle) {
            graphqlQuery = `
            {
                collectionByHandle(handle: "${handle}") {
                    id
                    sortOrder
                    ${productFragment}
                }
            }
            `;
        } else {
            return res.status(400).json({ error: true, message: "Collection ID or Handle required" });
        }

        // 2. Shopify'dan Ürünleri Çek
        const response = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
            body: JSON.stringify({ query: graphqlQuery }),
        });

        const json = await response.json();

        if (json.errors) return res.status(500).json({ error: true, message: json.errors });

        const collectionData = json.data.node || json.data.collectionByHandle;

        if (!collectionData) {
            return res.status(404).json({ error: true, message: "Koleksiyon bulunamadı" });
        }

        collectionId = collectionData.id;
        const currentSortOrder = collectionData.sortOrder;

        // --- KOLEKSİYON SIRALAMA TİPİNİ GÜNCELLEME ---
        // Eğer koleksiyon "MANUAL" değilse, önce onu "MANUAL" yapıyoruz.
        if (currentSortOrder !== 'MANUAL') {
            const updateCollectionMutation = `
            mutation collectionUpdate($input: CollectionInput!) {
                collectionUpdate(input: $input) {
                    collection {
                        id
                        sortOrder
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
            `;

            const updateResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                },
                body: JSON.stringify({
                    query: updateCollectionMutation,
                    variables: { input: { id: collectionId, sortOrder: "MANUAL" } }
                }),
            });

            const updateJson = await updateResponse.json();
            if (updateJson.data?.collectionUpdate?.userErrors?.length > 0) {
                console.error("Collection Update Error:", updateJson.data.collectionUpdate.userErrors);
            }
        }

        const rawProducts = collectionData.products.edges;

        // 3. İndirim Hesaplama Mantığı (DÜZELTİLEN KISIM)
        const products = rawProducts.map(({ node }) => {
            // İlk varyantı al (En güvenilir fiyat kaynağı burasıdır)
            const variantNode = node.variants?.edges?.node;

            // Fiyatları çekiyoruz. Varyant varsa oradan, yoksa genel aralıktan.
            let price = parseFloat(variantNode?.price || node.priceRange?.minVariantPrice?.amount || 0);
            
            // İndirimsiz fiyatı çekiyoruz.
            let compareAtPrice = parseFloat(variantNode?.compareAtPrice || node.compareAtPriceRange?.minVariantCompareAtPrice?.amount || 0);

            // GÜVENLİK KONTROLÜ:
            // Eğer compareAtPrice null ise veya 0 ise, indirim yok demektir.
            // Bu durumda compareAtPrice'ı normal fiyata eşitleyelim ki hesaplama bozulmasın.
            if (!compareAtPrice || compareAtPrice === 0) {
                compareAtPrice = price;
            }

            let discountPercentage = 0;

            // Sadece eski fiyat, şu anki fiyattan büyükse hesapla
            if (compareAtPrice > price && compareAtPrice > 0) {
                discountPercentage = Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
            }

            return {
                id: node.id,
                discount: discountPercentage
            };
        });

        // 4. Sıralama (Büyükten küçüğe - En yüksek indirim en üstte)
        const sortedProducts = products.sort((a, b) => b.discount - a.discount);

        // 5. Shopify'a Geri Yazma (Reorder Mutation)
        const moves = sortedProducts.map((product, index) => ({
            id: product.id,
            newPosition: index.toString()
        }));

        // Eğer sıralanacak ürün yoksa işlemi bitir
        if (moves.length === 0) {
             return res.status(200).json({ ok: true, message: "Sıralanacak ürün bulunamadı." });
        }

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

        // 6. Sonuç Döndür
        res.status(200).json({
            ok: true,
            moved: moves.length,
            shopifyResponse: reorderJson,
            sortOrderUpdated: currentSortOrder !== 'MANUAL'
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: true, message: error.message });
    }
};
