# Responsive QA — 18 cards

All 18 images loaded; no horizontal overflow in 360, 390, 660 and 800 px article widths.

Closed card height ranges:
- 360 px: 989–1131 px
- 390 px: 968–1054 px
- 660 px: 772–940 px
- 800 px: 704–817 px

With embed.js, iframe height equals rendered card height + 2 px. TUMI at 360 px expands from 1133 to 1305 px when sources are opened. Keep iframe scrolling enabled as a fallback.

Use class exame-product-card on each iframe and load embed.js once on the parent article. The receiver checks origin, source window, event type and bounds; the child sends only public ID and height.

If CMS strips scripts, use the supplied clamp fallback, accepting some whitespace and internal scrolling when sources expand.
