"""Small JPEG thumbnails for Stripe Checkout (storefront/assets/catalog/stripe/<id>.jpg).

Stripe documents JPEG/PNG for product images; the site keeps its WebP photos. Re-run after changing
a product's first photo. Needs Pillow (pip install pillow); without it, the existing files are kept.
"""
from pathlib import Path
import json, sys

root = Path(__file__).resolve().parent.parent
try:
    from PIL import Image
except ImportError:
    print('Pillow is not installed: Stripe thumbnails were not regenerated (pip install pillow).')
    sys.exit(0)

out = root / 'storefront/assets/catalog/stripe'
out.mkdir(parents=True, exist_ok=True)
products = json.loads((root / 'catalog-products.json').read_text())
for product in products:
    source = root / 'storefront' / product['images'][0]
    image = Image.open(source)
    if image.mode in ('RGBA', 'LA', 'P'):
        image = image.convert('RGBA')
        background = Image.new('RGBA', image.size, (252, 249, 242, 255))
        image = Image.alpha_composite(background, image)
    image = image.convert('RGB')
    image.thumbnail((600, 600), Image.LANCZOS)
    canvas = Image.new('RGB', (600, 600), (252, 249, 242))
    canvas.paste(image, ((600 - image.width) // 2, (600 - image.height) // 2))
    canvas.save(out / f"{product['id']}.jpg", 'JPEG', quality=85, optimize=True, progressive=True)
print(f'Prepared {len(products)} Stripe thumbnails in {out.relative_to(root)}')
