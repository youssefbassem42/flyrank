"""Scraper configuration."""

import os
from pathlib import Path

BASE_URL = "https://books.toscrape.com"

# Identify ourselves. A real scraper must be honest: who it is and how
# the site owner can get in touch. Put your own URL/email here.
USER_AGENT = os.environ.get(
    "SCRAPER_USER_AGENT",
    "flyrank-w5-scraper/1.0 (+https://github.com/youssef/flyrank; workshop exercise)",
)

DEFAULT_DELAY = float(os.environ.get("SCRAPER_DELAY", "1.0"))  # seconds between requests
DELAY_JITTER = 0.25  # +/- random jitter so traffic doesn't look like a metronome
REQUEST_TIMEOUT = 10  # seconds per request
MAX_RETRIES = 3
BACKOFF_BASE = 1.0  # seconds, doubled per retry
BACKOFF_MAX = 30.0

DEFAULT_MAX_PAGES = 50  # catalogue/page-N.html (20 books each -> 1000 books)
BOOK_LIMIT = os.environ.get("SCRAPER_BOOK_LIMIT")  # None = all books

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data"
BOOKS_JSONL = OUTPUT_DIR / "books.jsonl"
BOOKS_CSV = OUTPUT_DIR / "books.csv"
CRAWL_LOG = OUTPUT_DIR / "crawl.log"
META_JSON = OUTPUT_DIR / "meta.json"

DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en",
}
