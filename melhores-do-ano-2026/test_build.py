import unittest,json,re
from pathlib import Path
import build
class Cards(unittest.TestCase):
 def setUp(self):self.products=json.loads((build.ROOT/'products.json').read_text());self.css=(build.ROOT/'card.css').read_text()
 def test_unique_slots(self):self.assertGreaterEqual(len(self.products),12);self.assertEqual(len(self.products),len({p["id"] for p in self.products}))
 def test_accessibility_structure(self):
  for p in self.products:
   s=build.render(p,self.css)
   for marker in ['lang="pt-BR"','name="viewport"','<main ','<h1>','<summary>','<dt>','<dd>','focus-visible','max-width:650px']:
    self.assertIn(marker,s)
   self.assertEqual(s.count('<article '),1);self.assertEqual(s.count('<script '),1);self.assertIn('src="../resize.js"',s)
   if p.get('image'):self.assertIn('alt=',s);self.assertIn('/Divulgação',s)
 def test_no_fake_data(self):
  for p in self.products:
   s=build.render(p,self.css);self.assertNotIn('PRÉVIA EDITORIAL',s);self.assertNotIn('seleção provisória',s);self.assertNotIn('A confirmar',s);self.assertIn('Na prática',s)
 def test_live_blocked(self):
  for p in self.products:
   with self.assertRaises(AssertionError):build.validate(p,True)
 def test_escape(self):
  p=self.products[0];p['name']='<script>alert(1)</script>';s=build.render(p,self.css);self.assertNotIn('<script>',s);self.assertIn('&lt;script&gt;',s)
 def test_unverified_image_blocked(self):
  p=self.products[0];p['image']={'path':'assets/photo.png'}
  with self.assertRaises(AssertionError):build.validate(p)
if __name__=='__main__':unittest.main()
