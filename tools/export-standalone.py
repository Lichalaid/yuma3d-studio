from pathlib import Path
import base64,re,argparse
root=Path(__file__).resolve().parent.parent
src=root/'storefront'
parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);args=parser.parse_args()
s=(src/'index.html').read_text();css=(src/'styles.css').read_text()
for f in (src/'assets').glob('*.ttf'):
 css=css.replace('assets/'+f.name,'data:font/ttf;base64,'+base64.b64encode(f.read_bytes()).decode())
s=s.replace('<link rel="stylesheet" href="styles.css">','<style>'+css+'</style>').replace('<script src="app.js" defer></script>','')
for f in (src/'assets').rglob('*'):
 if f.suffix not in ['.png','.jpg','.jpeg','.webp']:continue
 mime='image/png' if f.suffix=='.png' else 'image/webp' if f.suffix=='.webp' else 'image/jpeg'
 key=f.relative_to(src).as_posix()
 s=re.sub(r'(?<![/\w-])'+re.escape(key),lambda _:'data:'+mime+';base64,'+base64.b64encode(f.read_bytes()).decode(),s)
s=s.replace('</body>','<script>'+(src/'app.js').read_text()+"\nif(!location.hash)location.hash='shop';\n</script></body>")
assert 'src="assets/' not in s and 'href="styles.css"' not in s and 'src="app.js"' not in s
args.output.parent.mkdir(exist_ok=True,parents=True);args.output.write_text(s)
print(args.output,args.output.stat().st_size)
