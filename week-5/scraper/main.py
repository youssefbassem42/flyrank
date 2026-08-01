"""Week 5 workshop: polite scraper for books.toscrape.com.

Pipeline: fetch -> parse -> extract -> clean -> structure.

Usage:
    python -m scraper.main [--limit N] [--delay SECONDS] [--max-pages N] [--resume]

Behaves like a guest, not a thief:
  * checks robots.txt first (RFC 9309 semantics, fail-closed on ambiguity)
  * identifies itself with a contactable User-Agent
  * rate-limits every request (default 1s + jitter)
  * retries transient failures with exponential backoff, honouring Retry-After
"""

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, parser
from .clean import build_record
from .client import PoliteClient, RobotsDisallowed
from .storage import RecordStore

log = logging.getLogger("scraper.main")


def build_cli() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Polite scraper for books.toscrape.com")
    p.add_argument("--limit", type=int, default=None,
                   help="stop after N books (default: all)")
    p.add_argument("--delay", type=float, default=None,
                   help="seconds between requests (default: %s)" % config.DEFAULT_DELAY)
    p.add_argument("--max-pages", type=int, default=config.DEFAULT_MAX_PAGES,
                   help="max catalogue pages to walk (default: %s)" % config.DEFAULT_MAX_PAGES)
    p.add_argument("--resume", action="store_true",
                   help="skip book URLs already present in the output JSONL")
    p.add_argument("--out", type=str, default=None,
                   help="output directory (default: %s)" % config.OUTPUT_DIR)
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return p


def crawl(client: PoliteClient, store: RecordStore, limit: int | None,
          max_pages: int, resume: bool) -> tuple[int, list[str]]:
    """Walk the catalogue, fetch every book, save clean records.

    Returns (books_scraped, errors)."""
    done = store.existing_urls() if resume else set()
    if resume and done:
        log.info("resuming: %d book(s) already on disk", len(done))

    scraped = 0
    errors = []
    listing_url = config.BASE_URL + "/catalogue/page-1.html"

    while listing_url and scraped != limit:
        log.info("listing: %s", listing_url)
        try:
            resp = client.fetch(listing_url)
        except (RobotsDisallowed, Exception) as exc:
            log.error("listing failed (%s): %s", listing_url, exc)
            errors.append(listing_url)
            break
        if resp.status_code == 404:
            log.info("no more pages (%s)", listing_url)
            break

        for book_url in parser.parse_listing(resp.text, listing_url):
            if scraped == limit:
                break
            if book_url in done:
                continue
            try:
                book_resp = client.fetch(book_url)
            except RobotsDisallowed as exc:
                log.error("blocked by robots: %s", exc)
                errors.append(book_url)
                continue
            except Exception as exc:
                log.error("failed %s: %s", book_url, exc)
                errors.append(book_url)
                continue
            if book_resp.status_code != 200:
                log.warning("skipping %s (HTTP %s)", book_url, book_resp.status_code)
                errors.append(book_url)
                continue

            raw = parser.parse_book(book_resp.text, book_url)
            record = build_record(raw)
            store.append(record)
            done.add(book_url)
            scraped += 1
            log.info("saved %3d. %s (%.2f GBP)", scraped, record["title"], record["price_incl_tax"] or 0)

        listing_url = parser.next_listing_page(resp.text, listing_url)
        if scraped == limit:
            break

    return scraped, errors


def main(argv=None) -> int:
    args = build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.out:
        out_dir = Path(args.out)
        config.OUTPUT_DIR = out_dir
        config.BOOKS_JSONL = out_dir / "books.jsonl"
        config.BOOKS_CSV = out_dir / "books.csv"
        config.CRAWL_LOG = out_dir / "crawl.log"
        config.META_JSON = out_dir / "meta.json"

    config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    file_handler = logging.FileHandler(config.CRAWL_LOG, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
    logging.getLogger().addHandler(file_handler)

    client = PoliteClient(delay=args.delay)
    store = RecordStore(config.BOOKS_JSONL, config.BOOKS_CSV)

    if not client.robots_available:
        log.error("robots.txt status unknown/forbidden -> refusing to crawl")
        return 1

    started = time.time()
    client.stats["started_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    scraped, errors = crawl(client, store, args.limit, args.max_pages, args.resume)
    client.stats["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    client.stats["duration_s"] = round(time.time() - started, 1)
    client.stats["books_scraped"] = scraped
    client.stats["errors"] = errors[:20]

    rows = store.write_csv()
    client.stats["records_on_disk"] = rows
    with config.META_JSON.open("w", encoding="utf-8") as fh:
        json.dump(client.stats, fh, indent=2, ensure_ascii=False)

    print("\n=== crawl finished ===")
    print(f"  books scraped : {scraped}")
    print(f"  records on disk: {rows}  ({config.BOOKS_JSONL})")
    print(f"  requests      : {client.stats['requests']}  ({client.stats['retries']} retries)")
    print(f"  status codes  : {client.stats['status_codes']}")
    print(f"  robots disallow: {client.stats['robots_disallowed']}")
    print(f"  errors        : {len(errors)}  ({client.stats['errors'][:5]})")
    print(f"  duration      : {client.stats['duration_s']}s  ->  {config.META_JSON}")
    client.close()
    return 0 if not errors else 2


if __name__ == "__main__":
    sys.exit(main())
