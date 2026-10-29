"""Build real, reloadable product URLs from the shared storefront template."""
from pathlib import Path
import html
import json
import re

root = Path(__file__).resolve().parent.parent
template = (root / 'storefront/index.html').read_text()
products = json.loads((root / 'catalog-products.json').read_text())
origin = 'https://yuma3d-studio-concept.lisanzampella.chatgpt.site'

for product in products:
    page = template.replace('<head>', '<head>\n<base href="/">', 1)
    page = page.replace('<body>', '<body data-product-id="' + product['id'] + '">', 1)
    page = page.replace('<main id="main">', '<main id="main" hidden>', 1)
    page = page.replace('<main id="product-page" hidden', '<main id="product-page"', 1)
    name = html.escape(product['name']['en'])
    title = name + ' | Yuma 3D Studio'
    page = re.sub(r'<title>.*?</title>', '<title>' + title + '</title>', page, count=1)
    page = re.sub(r'<meta name="description" content="[^"]*">', lambda _: '<meta name="description" content="' + html.escape(product['description']['en'][0], quote=True) + '">', page, count=1)
    page = re.sub(r'<meta property="og:title" content="[^"]*">', '<meta property="og:title" content="' + title + '">', page, count=1)
    url = origin + '/products/' + product['id'] + '/'
    page = re.sub(r'<meta property="og:url" content="[^"]*">', '<meta property="og:url" content="' + url + '"><link rel="canonical" href="' + url + '">', page, count=1)
    page = page.replace('<h1 id="product-title"></h1>', '<h1 id="product-title">' + name + '</h1>')
    page = page.replace('<span id="product-crumb-name"></span>', '<span id="product-crumb-name">' + name + '</span>')
    price = 'Request a quote' if product['price_cents'] is None else f"${product['price_cents'] / 100:.2f} USD"
    page = page.replace('<p class="product-detail-price" id="product-price"></p>', '<p class="product-detail-price" id="product-price">' + price + '</p>')
    description = ''.join('<p>' + html.escape(paragraph) + '</p>' for paragraph in product['description']['en'])
    page = page.replace('<div class="product-description" id="product-description"></div>', '<div class="product-description" id="product-description">' + description + '</div>')
    page = page.replace('<img id="product-main-image" alt="">', '<img id="product-main-image" src="' + product['images'][0] + '" alt="' + name + '" width="1024" height="1024">')
    output = root / 'storefront/products' / product['id'] / 'index.html'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(page)

print(f'Built {len(products)} product pages at /products/<id>/')

import runpy
runpy.run_path(str(root / 'tools/prepare-seo.py'), run_name='__main__')
