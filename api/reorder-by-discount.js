const fetch = require('node-fetch');

export default async function handler(req, res) {
    // CORS Ayarları (Tarayıcıdan erişim için)
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

    // Environment kontrolü
    if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({ 
            error: true, 
            message: 'Environment variables missing',
            missing: [
                !SHOPIFY_STORE_URL ? 'SHOPIFY_STORE_URL' : null,
                !SHOPIFY_ACCESS_TOKEN ? 'SHOPIFY_ACCESS_TOKEN' : null
            ].filter(Boolean)
        });
    }

    try {
        // 1. Shopify'dan Ürünleri ve Varyant Fiyatlarını Çek
        // Not: Fiyatlar "variants" içindedir. İlk varyantın fiyatını baz alacağız.
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

        // 2. Veriyi İşle ve İndirim Oranını Hesapla
        const products = json.data.products.edges.map(({ node }) => {
            // İlk varyantı al
            const variant = node.variants.edges,[object Object],?.node;
            
            // Fiyatları sayıya çevir
            const price = parseFloat(variant?.price || 0);
            const compareAtPrice = parseFloat(variant?.compareAtPrice || 0);

            // İndirim Hesaplama Mantığı
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

        // 3. İndirim Oranına Göre Sırala (Büyükten küçüğe)
        const sortedProducts = products.sort((a, b) => b.discount - a.discount);

        // 4. Sadece indirimi olanları filtrele (Opsiyonel - isterseniz kaldırabilirsiniz)
        const topDiscounts = sortedProducts.filter(p => p.discount > 0);

        res.status(200).json({
            success: true,
            count: sortedProducts.length,
            topDiscounts: topDiscounts, // Sadece indirimli olanlar
            allProducts: sortedProducts // Hepsi (sıralı)
        });

    } catch (error) {
        console.error("Sunucu Hatası:", error);
        res.status(500).json({ error: true, message: error.message });
    }
}
