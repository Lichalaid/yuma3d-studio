from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
import json, argparse, re
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('manifest',type=Path);parser.add_argument('--sheet',type=Path,required=True);args=parser.parse_args()
paths=json.loads(args.manifest.read_text());out=root/'storefront/assets/catalog/clean-v2';out.mkdir(exist_ok=True)
# Delivery resizing and encoding only: visual restoration is performed by imagegen.
for key,path in paths.items():
 im=Image.open(path).convert('RGB')
 im=ImageOps.pad(im,(1024,1024),method=Image.Resampling.LANCZOS,color='#F7F2EA',centering=(.5,.5))
 im.save(out/(key+'.webp'),'WEBP',quality=92,method=6)
products=json.loads((root/'catalog-products.json').read_text())
for p in products:
 p['images']=['assets/catalog/clean-v2/'+Path(f).stem+'.webp' for f in p['images']]
 p['source']['image_treatment']='Restauración y reencuadre a partir de la captura; formato cuadrado de 1024 × 1024 px.'
 for f in p['images']:assert (root/'storefront'/f).is_file(),f
(root/'catalog-products.json').write_text(json.dumps(products,ensure_ascii=False,indent=2)+'\n')
h=root/'storefront/index.html';s=h.read_text()
embedded='<script id="catalog-data" type="application/json">'+json.dumps(products,ensure_ascii=False).replace('</','<\\/')+'</script>'
s=re.sub(r'<script id="catalog-data" type="application/json">.*?</script>',lambda _:embedded,s,flags=re.S)
s=s.replace('Las fotografías del catálogo se extrajeron de las capturas compartidas.','Las fotografías del catálogo se restauraron y reencuadraron a partir de las capturas compartidas. Las partes tapadas por etiquetas se reconstruyeron siguiendo las referencias.')
h.write_text(s)
# Reduced contact sheet for internal visual inspection.
keys=list(paths);sheet=Image.new('RGB',(1000,((len(keys)+3)//4)*275),'#f7f2ea');draw=ImageDraw.Draw(sheet)
for i,key in enumerate(keys):
 im=Image.open(out/(key+'.webp'));im.thumbnail((245,245));x=(i%4)*250;y=(i//4)*275
 sheet.paste(im,(x+(250-im.width)//2,y));draw.text((x+5,y+249),key,fill='#343b31')
sheet.save(args.sheet)
print('Prepared',len(paths),'square images, 1024px, total',sum(p.stat().st_size for p in out.glob('*.webp')),'bytes')
