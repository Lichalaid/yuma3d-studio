"""Bundle the storefront and the checkout API into ONE Worker ESM file (dist/server/index.js).

Only needed for hosts that take a single self-contained Worker (the private chatgpt.site preview).
For Cloudflare use `npx wrangler deploy`: wrangler.jsonc serves storefront/ as Static Assets,
which keeps the Worker small (the single-file bundle is ~7 MB compressed, over the 3 MB free-plan limit).
"""
from pathlib import Path
import base64, json, mimetypes, re, shutil

root = Path(__file__).resolve().parent.parent
CATALOG_IMPORT = "import CATALOG from '../catalog-products.json' with { type: 'json' };"
FILES_TOKEN = '__STATIC_FILES__'

files = {}
for path in sorted((root / 'storefront').rglob('*')):
    if path.is_file():
        key = '/' + path.relative_to(root / 'storefront').as_posix()
        files[key] = {'type': mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                      'data': base64.b64encode(path.read_bytes()).decode()}

entry = (root / 'worker/index.js').read_text()
assert "import { handleRequest } from './checkout.js';" in entry and 'export default { fetch: handleRequest };' in entry, \
    'worker/index.js must only wire handleRequest from checkout.js'
source = (root / 'worker/checkout.js').read_text()
# Inline checkout.js: its named exports become plain declarations (Workers only accept handlers as exports).
assert not re.search(r'^export\s+(default|\{|\*)', source, re.M), 'checkout.js may only use `export function/class/const`'
source = re.sub(r'^export\s+(?=(?:async\s+function|function|class|const|let)\b)', '', source, flags=re.M)
assert not re.search(r'^export\b', source, re.M)
source += '\nexport default { fetch: handleRequest };\n'
assert source.count(CATALOG_IMPORT) == 1, 'checkout.js must import the catalog exactly once'
assert source.count(FILES_TOKEN) == 1, 'checkout.js must reference the embedded files exactly once'
catalog = json.loads((root / 'catalog-products.json').read_text())
source = source.replace(CATALOG_IMPORT, 'const CATALOG = ' + json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + ';')
source = source.replace(FILES_TOKEN, json.dumps(files, separators=(',', ':')))

out = root / 'dist/server'
out.mkdir(parents=True, exist_ok=True)
(out / 'index.js').write_text(source)
metadata = root / 'dist/.openai'
metadata.mkdir(exist_ok=True)
shutil.copyfile(root / '.openai/hosting.json', metadata / 'hosting.json')
print(f'Bundled {len(files)} static files and the checkout API ({len(source.encode())} bytes).')
