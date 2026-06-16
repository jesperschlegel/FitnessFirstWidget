import asyncio
import json
import re
from collections import Counter
from urllib.parse import urlparse

import aiohttp
from aiohttp import ClientTimeout
from bs4 import BeautifulSoup
from rapidfuzz import fuzz
from tqdm.asyncio import tqdm

BASE_URL = "https://www.fitnessfirst.de"
NETPULSE_BASE_URL = "https://fitnessfirst.netpulse.com"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
CLUBS_FILENAME = "assets/clubs.json"

FUZZY_MATCH_THRESHOLD = 90

# Applied during name normalisation so a "women" in a website URL slug matches
# the "(Ladies)" used in the corresponding Netpulse club name.
NAME_SYNONYMS = {"women": "ladies", "damen": "ladies"}

# Optional overrides for clubs the automatic matcher gets wrong:
#   "<url_id>": "<netpulse-uuid>"  -> force a specific Netpulse club
#   "<url_id>": None               -> exclude the club from the final list
# The matcher currently resolves every club on its own, so this is empty.
MANUAL_WEBSITE_TO_NETPULSE_UUID = {}

async def fetch_html(session, url):
    """Fetch HTML content with timeout and error handling."""
    try:
        async with session.get(url) as resp:
            resp.raise_for_status()
            return await resp.text()
    except Exception as e:
        print(f"Failed to fetch {url}: {e}")
        return ""


async def fetch_club_url_ids(session):
    xml = await fetch_html(session, SITEMAP_URL)
    url_ids = set()
    for loc in re.findall(r"<loc>(.*?)</loc>", xml):
        if "/clubs/" not in loc:
            continue
        slug = loc.split("/clubs/", 1)[1].strip("/").strip()
        if slug and "/" not in slug:  # single path segment only
            url_ids.add(slug)
    return sorted(url_ids)


def tidy_name(name):
    """Normalise separators so every name uses a plain hyphen."""
    return name.replace("–", "-").replace("—", "-")


def clean_title_name(title):
    """Derive a club name from the page <title>.

    Titles look like "Fitnessstudio Hamburg - Harburg | Fitness First".
    """
    name = title.split("|", 1)[0]
    name = re.sub(r"^\s*Fitnessstudio\s+", "", name)
    name = re.sub(r"\s*\(ehemals.*?\)", "", name)
    return re.sub(r"\s+", " ", name).strip()


def normalize_name(text):
    """Lowercase, transliterate umlauts, drop punctuation and apply synonyms."""
    text = (text or "").lower()
    for umlaut, repl in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(umlaut, repl)
    words = re.sub(r"[^a-z0-9]+", " ", text).split()
    return " ".join(NAME_SYNONYMS.get(w, w) for w in words)


async def fetch_club_data(session, sem, club_url_id):
    async with sem:
        url = f"{BASE_URL}/clubs/{club_url_id}"
        html = await fetch_html(session, url)

    if not html:
        return None

    soup = BeautifulSoup(html, "html.parser")
    section = soup.find("section", class_="show-club-checkin")
    if not (section and section.has_attr("data-club")):
        return None

    # Fallback name from the page itself; the canonical name comes from Netpulse.
    title = soup.title.get_text(strip=True) if soup.title else ""
    h1 = soup.find("h1")
    h1_name = h1.get_text(" ", strip=True) if h1 else ""
    name = clean_title_name(title) or h1_name or club_url_id
    return {
        "name": name,
        "h1_name": h1_name,
        "url_id": club_url_id,
        "usage_id": section["data-club"],
    }


async def fetch_netpulse_clubs_data(session):
    url = f"{NETPULSE_BASE_URL}/np/company/children"
    async with session.get(url) as resp:
        resp.raise_for_status()
        data = await resp.json()
        return data


def match_netpulse(netpulse_data, url_id, *name_hints):
    """Find the Netpulse club for a website club, or None if no confident match.

    Tries, in order: a manual override, an exact match on the slug embedded in
    the Netpulse club URL, then a fuzzy match of the normalised slug and any page
    name hints (title, heading) against the Netpulse name.
    """
    if url_id in MANUAL_WEBSITE_TO_NETPULSE_UUID:
        uuid = MANUAL_WEBSITE_TO_NETPULSE_UUID[url_id]
        return next((c for c in netpulse_data if c.get("uuid") == uuid), None)

    for club in netpulse_data:
        netpulse_url = club.get("url")
        if netpulse_url:
            slug = urlparse(netpulse_url).path.rstrip("/").split("/")[-1]
            if slug == url_id:
                return club

    slug_words = normalize_name(url_id.replace("-", " "))
    hints = [normalize_name(h) for h in name_hints if h]
    best, best_score = None, 0
    for club in netpulse_data:
        name = normalize_name(club.get("name"))
        score = max(
            [
                fuzz.token_sort_ratio(slug_words, name),
                fuzz.token_set_ratio(slug_words, name),
            ]
            + [fuzz.token_sort_ratio(hint, name) for hint in hints]
        )
        if score > best_score:
            best, best_score = club, score

    return best if best_score >= FUZZY_MATCH_THRESHOLD else None


async def main():
    sem = asyncio.Semaphore(20)  # Limit concurrent requests
    timeout = ClientTimeout(total=30)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        url_ids = await fetch_club_url_ids(session)
        netpulse_club_data = await fetch_netpulse_clubs_data(session)

        # Scrape every candidate page; non-club pages return None and drop out.
        tasks = [fetch_club_data(session, sem, url_id) for url_id in url_ids]
        clubs = []
        for r in tqdm(asyncio.as_completed(tasks), total=len(tasks)):
            res = await r
            if res:
                clubs.append(res)

    # Drop clubs explicitly excluded via manual mapping (e.g. permanently closed)
    clubs = [
        c
        for c in clubs
        if MANUAL_WEBSITE_TO_NETPULSE_UUID.get(c["url_id"], "keep") is not None
    ]

    # Match each club to its Netpulse counterpart (for the UUID and a clean name)
    for club in clubs:
        club["match"] = match_netpulse(
            netpulse_club_data, club["url_id"], club["name"], club["h1_name"]
        )

    # Prefer the cleaner Netpulse name, but when several website clubs map to the
    # same Netpulse club (e.g. two Hamburg-Harburg locations) keep the scraped
    # names so the entries stay distinguishable.
    claimed = Counter(c["match"]["uuid"] for c in clubs if c["match"])
    results = []
    for club in clubs:
        match = club["match"]
        if not match:
            print(f"Warning: No Netpulse match for '{club['name']}' ({club['url_id']})")
        unique_match = match is not None and claimed[match["uuid"]] == 1
        results.append(
            {
                "name": tidy_name(match["name"] if unique_match else club["name"]),
                "url_id": club["url_id"],
                "usage_id": club["usage_id"],
                "netpulse_uuid": match["uuid"] if match else None,
            }
        )

    # Sort by actual club name
    results.sort(key=lambda x: x["name"])

    # Save to JSON
    with open(CLUBS_FILENAME, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"Extracted {len(results)} clubs. Saved to {CLUBS_FILENAME}.")

    # Update README.md
    update_readme(results)


def update_readme(clubs):
    """Update the README.md file with the club list."""
    readme_path = "README.md"

    # Generate the table
    table_lines = [
        "| Name                                                    | ID         |",
        "|---------------------------------------------------------|------------|",
    ]
    for club in clubs:
        table_lines.append(f"| {club['name']:<55} | {club['usage_id']:<10} |")

    table_content = "\n".join(table_lines)

    # Read the existing README
    with open(readme_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Find the table section and replace it
    pattern = r"\| Name\s+\| ID\s+\|\n\|-+\|-+\|\n(?:\|.+\|\n)+"

    if re.search(pattern, content):
        updated_content = re.sub(pattern, table_content + "\n", content)

        with open(readme_path, "w", encoding="utf-8") as f:
            f.write(updated_content)

        print(f"Updated README.md with {len(clubs)} clubs.")
    else:
        print("Warning: Could not find table in README.md to update.")


if __name__ == "__main__":
    asyncio.run(main())
