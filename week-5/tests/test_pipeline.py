"""Unit tests for the scraping pipeline (parser + cleaner).

Run from week-5/ with:
    ../.venv/bin/python -m unittest discover -s tests -v
"""

import json
import tempfile
import unittest
from pathlib import Path

from scraper import clean, parser
from scraper.storage import RecordStore

FIXTURES = Path(__file__).parent / "fixtures"
BOOK_HTML = (FIXTURES / "book_detail.html").read_text(encoding="utf-8")
LISTING_HTML = (FIXTURES / "listing.html").read_text(encoding="utf-8")


class TestListingParser(unittest.TestCase):
    def test_extracts_20_books(self):
        urls = parser.parse_listing(LISTING_HTML, "https://books.toscrape.com/catalogue/page-1.html")
        self.assertEqual(len(urls), 20)
        self.assertTrue(all(u.startswith("https://books.toscrape.com/catalogue/") for u in urls))
        self.assertIn("https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html", urls)

    def test_next_listing_page(self):
        self.assertEqual(
            parser.next_listing_page(LISTING_HTML, "https://books.toscrape.com/catalogue/page-1.html"),
            "https://books.toscrape.com/catalogue/page-2.html",
        )

    def test_next_listing_page_none_at_end(self):
        html = '<html><ul class="pager"><li class="previous"><a>prev</a></li></ul></html>'
        self.assertIsNone(parser.next_listing_page(html, "https://x.test/page-50.html"))


class TestBookParser(unittest.TestCase):
    def setUp(self):
        self.raw = parser.parse_book(BOOK_HTML, "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html")

    def test_header_fields(self):
        self.assertEqual(self.raw["title"], "A Light in the Attic")
        self.assertEqual(self.raw["rating"], "Three")
        self.assertEqual(self.raw["availability"], "In stock (22 available)")
        self.assertEqual(self.raw["price_color"], "£51.77")

    def test_product_table_fields(self):
        self.assertEqual(self.raw["upc"], "a897fe39b1053632")
        self.assertEqual(self.raw["product_type"], "Books")
        self.assertEqual(self.raw["price_excl_tax"], "£51.77")
        self.assertEqual(self.raw["price_incl_tax"], "£51.77")
        self.assertEqual(self.raw["tax"], "£0.00")
        self.assertEqual(self.raw["number_of_reviews"], "0")

    def test_description(self):
        self.assertTrue(self.raw["description"].startswith("It's hard to imagine a world without A Light in the Attic"))

    def test_category_from_breadcrumb(self):
        self.assertEqual(self.raw["category"], "Poetry")

    def test_image_url_absolute(self):
        self.assertTrue(self.raw["image_url"].startswith("https://books.toscrape.com/media/cache/"))


class TestCleaner(unittest.TestCase):
    def test_clean_price(self):
        self.assertEqual(clean.clean_price("£51.77"), 51.77)
        self.assertEqual(clean.clean_price("£1,234.56"), 1234.56)
        self.assertEqual(clean.clean_price("£0.00"), 0.0)
        self.assertIsNone(clean.clean_price(""))
        self.assertIsNone(clean.clean_price(None))

    def test_clean_int(self):
        self.assertEqual(clean.clean_int("22"), 22)
        self.assertEqual(clean.clean_int("0"), 0)
        self.assertIsNone(clean.clean_int("n/a"))

    def test_clean_rating(self):
        self.assertEqual(clean.clean_rating("Three"), 3)
        self.assertEqual(clean.clean_rating("star-rating Five"), 5)
        self.assertIsNone(clean.clean_rating(None))

    def test_clean_availability(self):
        self.assertEqual(clean.clean_availability("In stock (22 available)"), (True, 22))
        self.assertEqual(clean.clean_availability("Out of stock"), (False, 0))
        self.assertEqual(clean.clean_availability("In stock"), (True, None))
        self.assertEqual(clean.clean_availability(None), (None, None))

    def test_clean_text_entities_and_whitespace(self):
        self.assertEqual(clean.clean_text("  It&#39;s  great  "), "It's great")
        self.assertIsNone(clean.clean_text("   "))

    def test_build_record_full_pipeline(self):
        raw = parser.parse_book(BOOK_HTML, "https://x.test/book_1/index.html")
        record = clean.build_record(raw, scraped_at="2026-08-01T00:00:00+00:00")
        self.assertEqual(record["title"], "A Light in the Attic")
        self.assertEqual(record["rating"], 3)
        self.assertEqual(record["price_incl_tax"], 51.77)
        self.assertEqual(record["in_stock"], True)
        self.assertEqual(record["stock_quantity"], 22)
        self.assertEqual(record["number_of_reviews"], 0)
        self.assertEqual(record["category"], "Poetry")


class TestStorage(unittest.TestCase):
    def test_jsonl_roundtrip_and_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = RecordStore(Path(tmp) / "books.jsonl", Path(tmp) / "books.csv")
            store.append({"url": "https://x.test/1", "title": "One"})
            store.append({"url": "https://x.test/2", "title": "Two"})
            self.assertEqual(store.existing_urls(), {"https://x.test/1", "https://x.test/2"})
            self.assertEqual(store.write_csv(), 2)
            rows = (Path(tmp) / "books.csv").read_text(encoding="utf-8").splitlines()
            self.assertEqual(rows[0].startswith("url,title"), True)


if __name__ == "__main__":
    unittest.main()
