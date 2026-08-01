"""HTML parsing -> raw (uncleaned) records.

Pure functions on HTML strings, no network access. Cleaning happens
separately in `clean.py` so each step is testable in isolation.
"""

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

LISTING_URL_RE = re.compile(r"page-(\d+)\.html$")


def parse_listing(html: str, base_url: str) -> list[str]:
    """Extract absolute book-detail URLs from a catalogue listing page."""
    soup = BeautifulSoup(html, "html.parser")
    urls = []
    for article in soup.select("article.product_pod"):
        link = article.select_one("h3 a") or article.select_one("a")
        if link and link.get("href"):
            urls.append(urljoin(base_url, link["href"]))
    return urls


def next_listing_page(html: str, current_url: str) -> str | None:
    """Return the URL of the next listing page, or None at the end."""
    soup = BeautifulSoup(html, "html.parser")
    nxt = soup.select_one("li.next a")
    if nxt and nxt.get("href"):
        return urljoin(current_url, nxt["href"])
    return None


def parse_book(html: str, url: str) -> dict:
    """Extract the raw fields from a book detail page.

    Returns a dict with raw string/None values. All values are cleaned
    in `clean.build_record`.
    """
    soup = BeautifulSoup(html, "html.parser")

    title_el = soup.select_one("div.product_main h1")
    title = title_el.get_text(strip=True) if title_el else None

    price_color_el = soup.select_one("p.price_color")
    price_color = price_color_el.get_text(strip=True) if price_color_el else None

    rating_el = soup.select_one("p.star-rating")
    rating = None
    if rating_el:
        classes = rating_el.get("class", [])
        rating = next((c for c in classes if c != "star-rating"), None)

    avail_el = soup.select_one("p.instock.availability")
    availability = avail_el.get_text(" ", strip=True) if avail_el else None

    desc_el = soup.select_one("#product_description")
    description = None
    if desc_el:
        p = desc_el.find_next_sibling("p")
        description = p.get_text(" ", strip=True) if p else None

    image_el = soup.select_one("#product_gallery img")
    image_url = None
    if image_el and image_el.get("src"):
        image_url = urljoin(url, image_el["src"])

    table = {}
    for row in soup.select("table.table-striped tr"):
        th = row.find("th")
        td = row.find("td")
        if th and td:
            table[th.get_text(strip=True)] = td.get_text(strip=True)

    category = None
    breadcrumb = soup.select_one("ul.breadcrumb")
    if breadcrumb:
        items = breadcrumb.find_all("li")
        if len(items) >= 3:
            category = items[-2].get_text(strip=True)
        elif len(items) == 2:
            category = items[-2].get_text(strip=True)

    return {
        "url": url,
        "title": title,
        "upc": table.get("UPC"),
        "product_type": table.get("Product Type"),
        "price_color": price_color,
        "price_excl_tax": table.get("Price (excl. tax)"),
        "price_incl_tax": table.get("Price (incl. tax)"),
        "tax": table.get("Tax"),
        "availability": availability,
        "rating": rating,
        "number_of_reviews": table.get("Number of reviews"),
        "description": description,
        "image_url": image_url,
        "category": category,
    }
