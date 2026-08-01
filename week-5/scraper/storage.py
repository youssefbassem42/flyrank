"""Record storage.

Writes each cleaned record to JSONL incrementally (crash-safe, easy to
append to next week's RAG corpus) and regenerates a CSV for humans at
the end of the crawl.
"""

import csv
import json
import logging
from pathlib import Path

log = logging.getLogger("scraper.storage")

FIELDS = [
    "url", "title", "category", "upc", "product_type",
    "price_incl_tax", "price_excl_tax", "tax", "rating",
    "in_stock", "stock_quantity", "number_of_reviews",
    "description", "image_url", "scraped_at",
]


class RecordStore:
    def __init__(self, jsonl_path: Path, csv_path: Path):
        self.jsonl_path = Path(jsonl_path)
        self.csv_path = Path(csv_path)
        self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)

    def existing_urls(self) -> set[str]:
        """URLs already written (for --resume)."""
        urls = set()
        if not self.jsonl_path.exists():
            return urls
        with self.jsonl_path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    urls.add(json.loads(line)["url"])
                except (json.JSONDecodeError, KeyError):
                    continue
        return urls

    def append(self, record: dict) -> None:
        with self.jsonl_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def write_csv(self) -> int:
        """Rewrite books.csv from the current JSONL. Returns row count."""
        if not self.jsonl_path.exists():
            return 0
        rows = []
        with self.jsonl_path.open(encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    rows.append(json.loads(line))
        with self.csv_path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        log.info("wrote %d rows to %s", len(rows), self.csv_path)
        return len(rows)
