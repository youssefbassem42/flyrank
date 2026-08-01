"""Cleaning and normalization: raw parsed strings -> typed, clean values.

Cleaning rules (each one is a pure function, unit-testable):
  * prices: "£51.77" -> 51.77 (float, GBP)
  * rating: "Three"  -> 3    (int 1-5)
  * availability: "In stock (22 available)" -> in_stock=True, quantity=22
  * integers: "0" -> 0
  * text: strip HTML entities, collapse whitespace, drop empty strings
  * unknown/missing -> None, never a sentinel string
"""

import html
import re
from datetime import datetime, timezone

WHITESPACE_RE = re.compile(r"\s+")
RATING_WORDS = {
    "One": 1, "Two": 2, "Three": 3, "Four": 4, "Five": 5,
}
STOCK_RE = re.compile(r"\((\d+)\s+available\)", re.IGNORECASE)


def clean_text(value: str | None) -> str | None:
    """Unescape entities and collapse whitespace. Empty -> None."""
    if value is None:
        return None
    value = html.unescape(value)
    value = WHITESPACE_RE.sub(" ", value).strip()
    return value or None


def clean_price(value: str | None) -> float | None:
    """Parse a currency string like '£51.77' (or '51.77') into a float."""
    if not value:
        return None
    digits = re.sub(r"[^\d.]", "", value.replace(",", ""))
    if not digits:
        return None
    return float(digits)


def clean_int(value: str | None) -> int | None:
    """Parse an integer string; None if empty/unparseable."""
    if value is None:
        return None
    digits = re.sub(r"[^\d-]", "", value.strip())
    try:
        return int(digits)
    except ValueError:
        return None


def clean_rating(value: str | None) -> int | None:
    """'Three' -> 3, 'star-rating Five' -> 5."""
    if not value:
        return None
    word = value.strip().split()[-1].title()
    return RATING_WORDS.get(word)


def clean_availability(value: str | None) -> tuple[bool | None, int | None]:
    """Return (in_stock, quantity).

    'In stock (22 available)' -> (True, 22)
    'Out of stock'            -> (False, 0)
    'In stock'                -> (True, None)
    """
    if not value:
        return (None, None)
    text = clean_text(value)
    in_stock = "out of stock" not in text.lower()
    match = STOCK_RE.search(text)
    quantity = clean_int(match.group(1)) if match else None
    if not in_stock:
        quantity = 0
    return (in_stock, quantity)


def build_record(raw: dict, scraped_at: str | None = None) -> dict:
    """Turn a raw parsed dict into a clean, typed record."""
    in_stock, quantity = clean_availability(raw.get("availability"))
    record = {
        "url": raw["url"],
        "title": clean_text(raw.get("title")),
        "category": clean_text(raw.get("category")),
        "upc": clean_text(raw.get("upc")),
        "product_type": clean_text(raw.get("product_type")),
        "price_incl_tax": clean_price(raw.get("price_incl_tax")),
        "price_excl_tax": clean_price(raw.get("price_excl_tax")),
        "tax": clean_price(raw.get("tax")),
        "rating": clean_rating(raw.get("rating")),
        "in_stock": in_stock,
        "stock_quantity": quantity,
        "number_of_reviews": clean_int(raw.get("number_of_reviews")),
        "description": clean_text(raw.get("description")),
        "image_url": raw.get("image_url"),
        "scraped_at": scraped_at
        or datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    # The visible price (p.price_color) is a fallback for books whose
    # product table omits the price breakdown.
    if record["price_incl_tax"] is None:
        record["price_incl_tax"] = clean_price(raw.get("price_color"))
    return record
