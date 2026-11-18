#!/usr/bin/env python3
"""Static independent card generator; preview default, publication guarded."""
import argparse,json,re,html
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def e(s): return html.escape(str(s),quote=True)
def valid_url(s): return isinstance(s,str) and s.startswith('https://')
def validate(p,live=False):
 assert re.fullmatch(r'[a-z0-9-]+',p['id']), 'Invalid id'
 if p.get('image'):
  i=p['image']; assert i.get('verified') is True, 'Image not inspected'
  if live: assert i.get('rights_verified') is True, 'Publication rights not verified'
  assert valid_url(i.get('source_url')) and i.get('alt') and i.get('credit'), 'Incomplete image provenance'
  assert re.fullmatch(r'assets/[a-zA-Z0-9_.-]+',i['path']), 'Invalid image path'
  assert (ROOT/i['path']).is_file(), 'Missing image file'
 if live:
  assert p.get('editorial_approved') is True and p.get('facts_verified') is True, 'Editorial/facts approval pending'
  assert p.get('name') and p.get('category') and p.get('verdict'), 'Incomplete editorial content'
  assert p.get('sources') and all(valid_url(x['url']) for x in p['sources']), 'Sources required'
  assert p.get('image'), 'Verified image required'
  assert all(x.get('value') for x in p['facts'] if x.get('value')), 'Facts incomplete'
def render(p,css,live=False):
 validate(p,live)
 name=p.get('name') or f"Produto {p['order']:02d} a definir"
 facts=''.join(f'<div class="fact"><dt>{e(x["label"])}</dt><dd>{e(x.get("value") or "")}</dd></div>' for x in p['facts'] if x.get('value'))
 image=p.get('image')
 if image:
  art=f'<img class="{e(image.get("kind", "product"))}" src="../{e(image["path"])}" alt="{e(image["alt"])}" width="{image["width"]}" height="{image["height"]}"><figcaption>{e(image["credit"])}</figcaption>'
 else:
  art='<div class="placeholder" aria-hidden="true">Foto oficial a verificar</div><figcaption>PLACEHOLDER • Nenhuma fotografia ou produto representado. Aguardando imagem autorizada.</figcaption>'
 sources=''.join(f'<li><a href="{e(s["url"])}" target="_blank" rel="noopener noreferrer">{e(s["label"])}</a></li>' for s in p.get('sources',[]) if valid_url(s.get('url')))
 details=p.get('reader_note') or ''
 notice=''
 accent=['#b4a1f8','#f5a5d1','#ffad72','#b8d9ed'][((p['order']-1)%4)]
 return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>{e(name)} — ficha EXAME</title><style>{css}</style></head><body>{notice}<main data-card-id="{e(p['id'])}"><article class="card" style="--accent:{accent}"><figure class="visual"><span class="badge">{e(p.get('category') or 'Categoria a definir')}</span>{art}</figure><div class="copy"><span class="kicker">{p['order']:02d} / Melhores do ano</span><h1>{e(name)}</h1><p class="dek">{e(p.get('description') or 'Apresentação editorial a preencher após a escolha e a apuração do produto.')}</p><dl>{facts}</dl><div class="verdict"><strong>Na prática</strong>{e(p.get('verdict') or 'Conclusão editorial pendente. Nenhum vencedor foi definido nesta ficha.')}</div><details><summary>Antes de escolher · ficha e fontes</summary><p>{e(details)}</p>{'<ul>'+sources+'</ul>' if sources else '<p>Fontes a acrescentar após a checagem.</p>'}</details></div></article></main><script src="../resize.js" defer></script></body></html>'''
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--production',action='store_true');args=parser.parse_args()
 products=json.loads((ROOT/'products.json').read_text())
 assert products and len({x['id'] for x in products})==len(products), 'Empty dataset or duplicate IDs'
 css=(ROOT/'card.css').read_text()
 rendered=[(p,render(p,css,args.production)) for p in products]
 (ROOT/'cards').mkdir(exist_ok=True)
 for p,doc in rendered:(ROOT/'cards'/f'{p["id"]}.html').write_text(doc)
 links=''.join(f'<li><a href="cards/{p["id"]}.html">{e(p.get("name") or p["id"])}</a></li>' for p in products)
 (ROOT/'index.html').write_text(f'<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Melhores do ano — EXAME</title><body style="font:18px/1.7 Arial;padding:24px"><h1>{len(products)} cards independentes</h1><p>Escolha um produto para abrir sua ficha.</p><ol>{links}</ol></body></html>')
 print(f'{len(rendered)} independent cards built; mode={"production" if args.production else "preview"}')
if __name__=='__main__':main()
