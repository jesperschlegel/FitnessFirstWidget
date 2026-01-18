import asyncio
import json
import re
from collections import defaultdict
from urllib.parse import urlparse

import aiohttp
from aiohttp import ClientTimeout
from bs4 import BeautifulSoup
from rapidfuzz import fuzz
from tqdm.asyncio import tqdm

BASE_URL = "https://www.fitnessfirst.de"
NETPULSE_BASE_URL = "https://fitnessfirst.netpulse.com"
CLUBS_FILENAME = "assets/clubs.json"

FUZZY_MATCH_THRESHOLD = 90


async def fetch_html(session, url):
    """Fetch HTML content with timeout and error handling."""
    try:
        async with session.get(url) as resp:
            resp.raise_for_status()
            return await resp.text()
    except Exception as e:
        print(f"Failed to fetch {url}: {e}")
        return ""


async def fetch_club_list(session):
    html_content = await fetch_html(session, f"{BASE_URL}/clubs")
    soup = BeautifulSoup(html_content, "html.parser")
    club_links = soup.find_all("a", href=lambda x: x and x.startswith("/clubs/"))

    url_to_names = defaultdict(set)
    for a in club_links:
        url_to_names[a["href"]].add(a.get_text(strip=True))

    # Only keep URLs with "Club auswählen" and another actual name
    sanitized_clubs = [
        [
            url.replace("/clubs/", ""),
            next(n for n in names if n != "Club auswählen")
            .replace("Fitnessstudio", "")
            .strip(),
        ]
        for url, names in url_to_names.items()
        if "Club auswählen" in names and len(names) > 1
    ]
    return sanitized_clubs


async def fetch_club_id(session, sem, club_url_id):
    async with sem:
        url = f"{BASE_URL}/clubs/{club_url_id}"
        html = await fetch_html(session, url)
        if not html:
            return None

        soup = BeautifulSoup(html, "html.parser")
        section = soup.find("section", class_="show-club-checkin")
        if section and section.has_attr("data-club"):
            return section["data-club"]
        return None


async def build_club_data(
    session, sem, club_url_id, club_name, netpulse_uuid_by_url_id
):
    return {
        "name": club_name,
        "url_id": club_url_id,
        "usage_id": await fetch_club_id(session, sem, club_url_id),
        "netpulse_uuid": netpulse_uuid_by_url_id.get(club_url_id, None),
    }


async def fetch_netpulse_clubs_data(session):
    url = f"{NETPULSE_BASE_URL}/np/company/children"
    async with session.get(url) as resp:
        resp.raise_for_status()
        data = await resp.json()
        return data


def get_netpulse_uuid_mapping(netpulse_data, website_club_list):
    mapping = {}
    website_club_list_copy = website_club_list.copy()
    for url_id, website_name in website_club_list_copy:
        uuid = None

        for netpulse_club in netpulse_data:
            netpulse_url = netpulse_club.get("url")
            if netpulse_url is not None:
                path = urlparse(netpulse_url).path
                netpulse_url_id = path.rstrip("/").split("/")[-1]
                if netpulse_url_id == url_id:
                    uuid = netpulse_club.get("uuid", None)
                    break

            if (
                fuzz.ratio(website_name, netpulse_club.get("name", ""))
                > FUZZY_MATCH_THRESHOLD
            ):
                uuid = netpulse_club.get("uuid", None)
                break

        if uuid is not None:
            mapping[url_id] = uuid
        else:
            print(
                f"Warning: No matching Netpulse UUID found for club '{website_name}' ({url_id})"
            )

    return mapping


async def main():
    sem = asyncio.Semaphore(20)  # Limit concurrent requests
    timeout = ClientTimeout(total=30)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        club_list = await fetch_club_list(session)
        netpulse_club_data = await fetch_netpulse_clubs_data(session)
        netpulse_uuid_by_url_id = get_netpulse_uuid_mapping(
            netpulse_club_data, club_list
        )

        tasks = [
            build_club_data(
                session, sem, club_url_id, club_name, netpulse_uuid_by_url_id
            )
            for club_url_id, club_name in club_list
        ]

        results = []
        for r in tqdm(asyncio.as_completed(tasks), total=len(tasks)):
            res = await r
            if res:
                results.append(res)

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
