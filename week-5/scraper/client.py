"""Polite HTTP client.

Responsibilities:
  * robots.txt compliance (RFC 9309 semantics)
  * honest identification (User-Agent with contact info)
  * rate limiting between requests (with jitter)
  * retries with exponential backoff, honouring Retry-After
  * request/error stats for the crawl report
"""

import logging
import random
import time
from urllib import robotparser
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RequestRate

import requests

from . import config

log = logging.getLogger("scraper.client")


class RobotsDisallowed(Exception):
    """Raised when robots.txt forbids fetching a URL."""


class PoliteClient:
    def __init__(self, delay: float = None, user_agent: str = None):
        self.delay = config.DEFAULT_DELAY if delay is None else delay
        self.user_agent = user_agent or config.USER_AGENT
        self.session = requests.Session()
        self.session.headers.update(config.DEFAULT_HEADERS)
        self.session.headers["User-Agent"] = self.user_agent

        self.stats = {
            "requests": 0,
            "retries": 0,
            "errors": 0,
            "robots_disallowed": 0,
            "status_codes": {},
            "started_at": None,
            "finished_at": None,
            "robots_url": None,
        }

        self.robots = robotparser.RobotFileParser()
        self.robots_available = self._load_robots()

    # ------------------------------------------------------------------ robots

    def _load_robots(self) -> bool:
        """Fetch and parse robots.txt.

        RFC 9309 semantics:
          * 401/403      -> fail closed: treat everything as disallowed
          * 404/410      -> fail open: no restrictions
          * other 4xx/5xx -> be conservative and fail closed (log it)
        """
        robots_url = urljoin(config.BASE_URL, "/robots.txt")
        self.stats["robots_url"] = robots_url
        try:
            resp = self.session.get(
                robots_url,
                timeout=config.REQUEST_TIMEOUT,
                headers={"User-Agent": self.user_agent},
            )
        except requests.RequestException as exc:
            log.warning("robots.txt unreachable (%s); crawling conservatively", exc)
            return False

        if resp.status_code == 401 or resp.status_code == 403:
            log.warning("robots.txt returned %s -> ALL crawling is disallowed", resp.status_code)
            return False
        if resp.status_code in (404, 410):
            log.info("robots.txt missing (%s): no crawl restrictions", resp.status_code)
            self.robots.parse([])
            return True
        if resp.status_code >= 400:
            log.warning("robots.txt returned %s; crawling conservatively", resp.status_code)
            return False

        self.robots.parse(resp.text.splitlines())
        rate = self.robots.request_rate(self.user_agent) or self.robots.request_rate("*")
        if rate:
            log.info("robots.txt crawl-delay/rate: %s", rate)
        log.info("robots.txt loaded: %s", self.robots_url() or "n/a")
        return True

    def robots_url(self):
        return self.robots.base_url

    def is_allowed(self, url: str) -> bool:
        if not self.robots_available:
            return False  # fail closed
        return self.robots.can_fetch(self.user_agent, url)

    # ------------------------------------------------------------------ fetch

    def _throttle(self):
        """Sleep so we never exceed one request per `self.delay` seconds."""
        if self.delay > 0:
            time.sleep(max(0.0, self.delay + random.uniform(-config.DELAY_JITTER, config.DELAY_JITTER)))

    def _backoff(self, attempt: int, retry_after: float = None) -> float:
        if retry_after is not None:
            return min(retry_after, config.BACKOFF_MAX)
        return min(config.BACKOFF_BASE * (2 ** attempt), config.BACKOFF_MAX)

    def fetch(self, url: str, retries: int = None) -> requests.Response:
        """Fetch a URL politely. Raises RobotsDisallowed if not permitted."""
        if not self.is_allowed(url):
            self.stats["robots_disallowed"] += 1
            raise RobotsDisallowed(f"robots.txt disallows: {url}")

        self._throttle()
        retries = config.MAX_RETRIES if retries is None else retries
        last_error = None

        for attempt in range(retries + 1):
            try:
                resp = self.session.get(url, timeout=config.REQUEST_TIMEOUT)
                self.stats["requests"] += 1
                self.stats["status_codes"][resp.status_code] = (
                    self.stats["status_codes"].get(resp.status_code, 0) + 1
                )

                if resp.status_code == 429 or resp.status_code >= 500:
                    retry_after = None
                    if "Retry-After" in resp.headers:
                        try:
                            retry_after = float(resp.headers["Retry-After"])
                        except ValueError:
                            retry_after = None
                    if attempt < retries:
                        wait = self._backoff(attempt, retry_after)
                        log.warning(
                            "HTTP %s for %s; retry %d in %.1fs",
                            resp.status_code, url, attempt + 1, wait,
                        )
                        self.stats["retries"] += 1
                        time.sleep(wait)
                        continue
                    resp.raise_for_status()

                if resp.status_code == 404:
                    log.warning("404 for %s (skipping)", url)
                return resp

            except requests.RequestException as exc:
                last_error = exc
                if attempt < retries:
                    wait = self._backoff(attempt)
                    log.warning("%s for %s; retry %d in %.1fs", exc, url, attempt + 1, wait)
                    self.stats["retries"] += 1
                    time.sleep(wait)
                    continue
                self.stats["errors"] += 1
                raise

        raise last_error if last_error else requests.RequestException(f"failed to fetch {url}")

    # ------------------------------------------------------------------ util

    def absolute(self, base: str, href: str) -> str:
        return urljoin(base, href)

    def close(self):
        self.session.close()
