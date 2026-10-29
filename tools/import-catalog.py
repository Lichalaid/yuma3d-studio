from pathlib import Path
from PIL import Image
import json,re,argparse
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('input_dir',type=Path)
args=parser.parse_args()
uploads=args.input_dir
assets=root/'storefront/assets/catalog'
# Exact photographic rectangles from the supplied catalog screenshots. No image is synthesized.
slots={'tl':(760,234,932,466),'tr':(1038,234,1209,466),'bl':(740,565,921,794),'br':(1024,565,1199,794)}
rows=[
('social-display-white','124111','tl'),('social-display-pink','124111','tr'),('business-logo','124111','bl'),('social-nfc-keychain','124111','br'),
('wall-name-seven','124119','tl'),('wall-name-four','124119','tr'),('initial-name','124119','bl'),('double-name','124119','br'),
('name-accessory-keychain','124138','tl'),('fitness-keychain','124138','tr'),('lipgloss-keychain','124138','bl'),('raised-name-keychain','124138','br'),
('two-names-keychain','124144','tl'),('can-opener-keychain','124144','tr'),('wholesale-keychains','124144','bl'),('charms-keychain','124144','br'),
('personalized-can-cooler','124152','tl')]
for name,stamp,slot in rows:
 box=slots[slot]
 if name=='charms-keychain':box=(1038,568,1209,795)
 Image.open(uploads/f'image(20261028-{stamp}).png').crop(box).save(assets/f'{name}.png')
products=[
('wall-name-seven','names','Nombre personalizado de pared + 7 accesorios','Wall name + 7 accessories',3500,['wall-name-seven'],'124119'),
('wall-name-four','names','Nombre personalizado de pared + 4 accesorios','Wall name + 4 accessories',3000,['wall-name-four'],'124119'),
('initial-name','names','Inicial + nombre para decoración','Decorative initial + name',3500,['initial-name'],'124119'),
('double-name','names','Nombre compuesto + 4 accesorios','Double name + 4 accessories',5000,['double-name'],'124119'),
('name-accessory-keychain','keychains','Nombre + accesorio','Name + accessory keychain',800,['name-accessory-keychain'],'124138'),
('fitness-keychain','keychains','Llavero fitness','Fitness keychain',800,['fitness-keychain'],'124138'),
('lipgloss-keychain','keychains','Llavero porta lipgloss','Lip gloss holder keychain',800,['lipgloss-keychain'],'124138'),
('raised-name-keychain','keychains','Nombre en relieve','Raised name keychain',800,['raised-name-keychain'],'124138'),
('two-names-keychain','keychains','2 nombres + accesorio','Two names + accessory keychain',1500,['two-names-keychain'],'124144'),
('can-opener-keychain','keychains','Llavero abridor de latas','Can opener keychain',500,['can-opener-keychain'],'124144'),
('charms-keychain','keychains','Llavero de charms','Charm keychain',1500,['charms-keychain'],'124144'),
('social-display','business','Exhibidor de redes sociales con chip NFC','NFC social media display',6000,['social-display-white','social-display-pink'],'124111'),
('business-logo','business','Logos para negocios','Business logo sign',7000,['business-logo'],'124111'),
('social-nfc-keychain','business','Llavero con chip para redes sociales','Social media chip keychain',1500,['social-nfc-keychain'],'124111'),
('wholesale-keychains','business','Llaveros a mayoreo para negocios','Wholesale keychains for businesses',None,['wholesale-keychains'],'124144'),
('personalized-can-cooler','other','Termo enfriador de latas personalizado','Personalized can cooler',3000,['personalized-can-cooler'],'124152')]
data=[]
for id,cat,es,en,price,photos,source in products:
 data.append({'id':id,'category':cat,'name':{'en':en,'es':es},'price_cents':price,'currency':'USD','images':['assets/catalog/'+p+'.png' for p in photos],'source':{'file':f'image(20261028-{source}).png','price_text':'$DM?' if price is None else '$'+str(price//100),'note':'Dos fotografías del mismo producto con igual nombre y precio.' if id=='social-display' else ''}})
existing={p['id']:p for p in json.loads((root/'catalog-products.json').read_text())} if (root/'catalog-products.json').exists() else {}
for item in data:
 for field in ('description','personalization'):
  if field in existing.get(item['id'],{}):item[field]=existing[item['id']][field]
(root/'catalog-products.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
# Replace the embedded dataset without changing the storefront layout.
html=root/'storefront/index.html'
s=html.read_text()
embedded='<script id="catalog-data" type="application/json">'+json.dumps(data,ensure_ascii=False).replace('</','<\\/')+'</script>'
s=re.sub(r'<script id="catalog-data" type="application/json">.*?</script>',lambda _:embedded,s,flags=re.S)
html.write_text(s)
print('Imported',len(data),'products and',sum(len(p['images']) for p in data),'photographs')
