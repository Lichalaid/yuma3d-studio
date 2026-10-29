"""Add crawlable catalog links and verified business/product metadata."""
from pathlib import Path
import html
import json
import os
import re
from xml.sax.saxutils import escape as xml_escape

root = Path(__file__).resolve().parent.parent
settings = json.loads((root / 'site-settings.json').read_text())
origin = os.environ.get('SITE_ORIGIN', settings['origin']).rstrip('/')
if not origin.startswith('https://') or any(c in origin for c in ['"', '<', '>', ' ']):
    raise ValueError('SITE_ORIGIN must be an HTTPS origin')
products = json.loads((root / 'catalog-products.json').read_text())
categories = {'names': 'Names', 'keychains': 'Keychains', 'business': 'For businesses', 'other': 'Other designs'}
def metadata(page, title, description, url, image, extra):
    page = re.sub(r'<title>.*?</title>', '', page, count=1)
    page = re.sub(r'<meta (?:name="(?:description|author|robots|theme-color|twitter:[^"]*)"|property="og:[^"]*")[^>]*>', '', page)
    page = re.sub(r'<link rel="(?:canonical|icon)"[^>]*>', '', page)
    page = re.sub(r'<script id="site-schema".*?</script>', '', page, flags=re.S)
    organization = {'@type': 'Organization', '@id': origin + '/#studio', 'name': 'Yuma 3D Studio', 'url': origin + '/', 'logo': origin + '/assets/logo-original.png', 'telephone': '+18325072768', 'email': 'yuma3dstudio@gmail.com', 'address': {'@type': 'PostalAddress', 'addressLocality': 'Houston', 'addressRegion': 'TX', 'addressCountry': 'US'}, 'sameAs': ['https://www.instagram.com/yuma3dstudio/', 'https://www.facebook.com/share/1DoxDMzkqH/']}
    creator = {'@type': 'Person', '@id': origin + '/#web-creator', 'name': settings['creator'], 'worksFor': {'@type': 'Organization', 'name': settings['agency'], 'url': settings['agency_url']}}
    website = {'@type': 'WebSite', '@id': origin + '/#website', 'url': origin + '/', 'name': 'Yuma 3D Studio', 'publisher': {'@id': origin + '/#studio'}, 'creator': {'@id': origin + '/#web-creator'}, 'inLanguage': ['en', 'es']}
    tags = [f'<title>{html.escape(title)}</title>', f'<meta name="description" content="{html.escape(description, quote=True)}">', f'<meta name="author" content="{html.escape(settings["creator"] + " · " + settings["agency"], quote=True)}">', '<meta name="robots" content="index,follow,max-image-preview:large">', '<meta name="theme-color" content="#fcf9f2">', f'<link rel="canonical" href="{html.escape(url, quote=True)}">', '<link rel="icon" type="image/png" href="assets/logo-original.png">']
    for key, value in {'og:type': 'website' if url == origin + '/' else 'product', 'og:site_name': 'Yuma 3D Studio', 'og:title': title, 'og:description': description, 'og:url': url, 'og:image': origin + '/' + image, 'og:image:alt': title, 'og:locale': 'en_US'}.items():
        tags.append(f'<meta property="{key}" content="{html.escape(value, quote=True)}">')
    tags += ['<meta name="twitter:card" content="summary_large_image">', f'<meta name="twitter:title" content="{html.escape(title, quote=True)}">', f'<meta name="twitter:description" content="{html.escape(description, quote=True)}">', f'<meta name="twitter:image" content="{origin}/{image}">']
    schema = json.dumps({'@context': 'https://schema.org', '@graph': [organization, creator, website, *extra]}, ensure_ascii=False).replace('<', '\\u003c')
    tags.append('<script id="site-schema" type="application/ld+json">' + schema + '</script>')
    return page.replace('</head>', '\n'.join(tags) + '\n</head>', 1)

cards = []
for product in products:
    name = html.escape(product['name']['en']); url = '/products/' + product['id'] + '/'
    price = 'Request a quote' if product['price_cents'] is None else f"${product['price_cents'] / 100:.2f}"
    cards.append(f'<article class="catalog-card"><a class="catalog-photo" href="{url}" aria-label="View {name}"><img src="{product["images"][0]}" alt="{name}" loading="lazy" width="1024" height="1024"><span class="round-arrow" aria-hidden="true">↗</span></a><p class="catalog-category">{categories[product["category"]]}</p><div class="catalog-product-line"><h3><a href="{url}">{name}</a></h3><p>{price}</p></div><a class="text-link" href="{url}">View piece ↗</a></article>')
catalog = '<!--CATALOG:START-->' + ''.join(cards) + '<!--CATALOG:END-->'
for path in [root / 'storefront/index.html', *[root / 'storefront/products' / p['id'] / 'index.html' for p in products]]:
    page = path.read_text()
    if '<!--CATALOG:START-->' in page:
        page = re.sub(r'<!--CATALOG:START-->.*?<!--CATALOG:END-->', lambda _: catalog, page, count=1, flags=re.S)
    else:
        page = page.replace('<div class="catalog-grid" id="catalog-grid"></div>', '<div class="catalog-grid" id="catalog-grid">' + catalog + '</div>', 1)
    product = next((p for p in products if p['id'] == path.parent.name), None)
    if product:
        url = origin + '/products/' + product['id'] + '/'
        schema = {'@type': 'Product', '@id': url + '#product', 'name': product['name']['en'], 'description': ' '.join(product['description']['en']), 'image': [origin + '/' + f for f in product['images']], 'url': url, 'sku': product['id'], 'brand': {'@type': 'Brand', 'name': 'Yuma 3D Studio'}}
        if product['price_cents'] is not None:
            schema['offers'] = {'@type': 'Offer', 'url': url, 'priceCurrency': 'USD', 'price': f"{product['price_cents'] / 100:.2f}", 'seller': {'@id': origin + '/#studio'}}
        breadcrumb = {'@type': 'BreadcrumbList', 'itemListElement': [{'@type': 'ListItem', 'position': 1, 'name': 'The collection', 'item': origin + '/#shop'}, {'@type': 'ListItem', 'position': 2, 'name': product['name']['en'], 'item': url}]}
        page = metadata(page, product['name']['en'] + ' | Yuma 3D Studio', product['description']['en'][0], url, product['images'][0], [schema, breadcrumb])
    else:
        items = {'@type': 'ItemList', 'itemListElement': [{'@type': 'ListItem', 'position': i + 1, 'url': origin + '/products/' + p['id'] + '/', 'name': p['name']['en']} for i, p in enumerate(products)]}
        page = metadata(page, 'Yuma 3D Studio | Personalized 3D Gifts in Houston', 'Personalized 3D-printed name signs, keychains, photo frames and business displays. Made to order in Houston, Texas. Shipping across the US and Puerto Rico.', origin + '/', 'assets/catalog/clean-v2/initial-name.webp', [items])
    path.write_text(page)
urls = [origin + '/', *[origin + '/products/' + p['id'] + '/' for p in products]]
(root / 'storefront/sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join('<url><loc>' + xml_escape(url) + '</loc></url>' for url in urls) + '</urlset>\n')
(root / 'storefront/robots.txt').write_text('User-agent: *\nAllow: /\nSitemap: ' + origin + '/sitemap.xml\n')
(root / 'storefront/404.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found | Yuma 3D Studio</title><body style="font:18px/1.7 Arial,sans-serif;background:#fcf9f2;color:#343b31;padding:10vw"><h1>This page has moved.</h1><p>Find your next personalized piece in the collection.</p><a href="/">Back to Yuma 3D Studio ↗</a></body></html>')
print(f'Prepared SEO for {len(products) + 1} URLs at {origin}')
