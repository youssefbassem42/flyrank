# Week 5 — Polite Web Scraper (books.toscrape.com)

A professional-grade scraper: **fetch → parse → extract → clean → structure**. It collects all 1,000 books from the practice site [books.toscrape.com](https://books.toscrape.com) ("We love being scraped!") and saves one clean, typed record per book.

The output (`data/books.jsonl`) is the corpus for **Week 6's RAG system** — the pipeline is exactly what powers "AI applications" that are really data-gathering apps with a model attached.

## Why this site?

- Explicitly built for scraping practice; data is randomly generated
- 1,000 books with rich fields: title, price, tax, rating, stock, description, category, UPC
- Pagination (50 catalogue pages × 20 books) and per-book detail pages

## Behaving like a guest, not a thief

The professionalism layer — everything a site owner wants to see from a bot:

| Concern | Implementation |
|---|---|
| **robots.txt** | Checked before every request. RFC 9309 semantics: 404/410 → crawl freely; 401/403/5xx → fail **closed** and refuse to crawl |
| **Identification** | Contactable `User-Agent` (`flyrank-w5-scraper/1.0 (+github.com/youssef/flyrank)`) — no fake browser strings |
| **Rate limiting** | One request per `delay` (default 1.0 s) with ±0.25 s jitter |
| **Retries** | Exponential backoff (1 s → 30 s max) on 429/5xx, honours `Retry-After` |
| **Errors** | 404s skipped, per-URL error list, stats written to `data/meta.json` |
| **Resume** | `--resume` skips URLs already on disk — restarts cost nothing |

## Setup

```bash
python -m venv .venv        # or reuse the repo's root .venv
../.venv/bin/python -m pip install -r requirements.txt
```

## Usage

```bash
# Full crawl: all 1000 books (default delay 1s -> ~20 min)
../.venv/bin/python -m scraper.main

# Quick test: 3 books, fast
../.venv/bin/python -m scraper.main --limit 3 --delay 0.3

# Continue an interrupted crawl
../.venv/bin/python -m scraper.main --resume

# Custom output directory
../.venv/bin/python -m scraper.main --out /tmp/books

# Verbose (debug) logging
../.venv/bin/python -m scraper.main -v
```

## Project structure

```
week-5/
├── requirements.txt        # requests, beautifulsoup4
├── scraper/
│   ├── config.py           # UA, delays, retries, paths
│   ├── client.py           # polite HTTP client (robots, throttle, backoff)
│   ├── parser.py           # HTML -> raw dicts (pure, no network)
│   ├── clean.py            # raw -> clean typed records (pure)
│   ├── storage.py          # JSONL append + CSV export
│   └── main.py             # pipeline orchestration + CLI
├── tests/                  # 15 unit tests + saved HTML fixtures
└── data/                   # books.jsonl, books.csv, meta.json, logs
```

## Pipeline (fetch → parse → extract → clean → structure)

1. **Fetch** — `PoliteClient.fetch()`: robots check → throttle → GET with retries. Records status codes and timings.
2. **Parse** — `parser.parse_listing()` extracts the 20 book URLs per page; `parser.next_listing_page()` follows `li.next` until page 50; `parser.parse_book()` pulls the raw fields from each detail page (breadcrumb for category, `table.table-striped` for the product table, `#product_description` for the blurb).
3. **Clean** — `clean.build_record()`: `"£51.77"` → `51.77`, `"Three"` → `3`, `"In stock (22 available)"` → `in_stock=True, stock_quantity=22`, HTML entities unescaped, whitespace collapsed, missing → `None` (never sentinel strings).
4. **Structure** — one JSON object per line in `data/books.jsonl` (append-only, crash-safe, ideal for RAG ingestion), plus a CSV mirror and `data/meta.json` crawl stats.

## Output schema (books.jsonl)

```json
{
  "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
  "title": "A Light in the Attic",
  "category": "Poetry",
  "upc": "a897fe39b1053632",
  "product_type": "Books",
  "price_incl_tax": 51.77,
  "price_excl_tax": 51.77,
  "tax": 0.0,
  "rating": 3,
  "in_stock": true,
  "stock_quantity": 22,
  "number_of_reviews": 0,
  "description": "It's hard to imagine a world without A Light in the Attic...",
  "image_url": "https://books.toscrape.com/media/cache/...",
  "scraped_at": "2026-08-01T20:06:23+00:00"
}
```

## Tests

```bash
../.venv/bin/python -m unittest discover -s tests -v
```

15 tests cover the parser (listing extraction, pagination, detail fields, breadcrumb category) and every cleaning rule (prices, ratings, stock, entities), plus a JSONL/CSV storage round-trip — using saved HTML fixtures, so they never touch the network.

## Crawl results

Full crawl of all 1,000 books (default 1 s delay, ~21 min):

```
books scraped : 1000 / 1000
requests      : 965 (0 retries, 0 errors)
status codes  : {200: 965} — every request returned 200
robots disallow: 0
duration      : 1263.5s
```

Field coverage on `data/books.jsonl`: title/category/UPC/price/rating/stock/image 100%; description missing on only 2 books (the site has none for them). Ratings 1–5 are near-uniform and prices span £10.00–£59.99 (randomly assigned by the sandbox). 50 categories. See `data/meta.json` for the full report.
