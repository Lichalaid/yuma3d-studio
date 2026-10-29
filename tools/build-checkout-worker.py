"""Bundle the storefront and the checkout API into one Worker ESM."""
from pathlib import Path
import base64,json,mimetypes,shutil
root=Path(__file__).resolve().parent.parent
files={}
for path in sorted((root/'storefront').rglob('*')):
    if path.is_file():
        key='/'+path.relative_to(root/'storefront').as_posix()
        files[key]={'type':mimetypes.guess_type(path.name)[0] or 'application/octet-stream','data':base64.b64encode(path.read_bytes()).decode()}
source=(root/'worker/index.js').read_text().replace('__STATIC_FILES__',json.dumps(files,separators=(',',':'))).replace('__CATALOG__',(root/'catalog-products.json').read_text())
out=root/'dist/server';out.mkdir(parents=True,exist_ok=True)
(out/'index.js').write_text(source)
metadata=root/'dist/.openai';metadata.mkdir(exist_ok=True)
shutil.copyfile(root/'.openai/hosting.json',metadata/'hosting.json')
print(f'Bundled {len(files)} static files and the checkout API ({len(source.encode())} bytes).')
