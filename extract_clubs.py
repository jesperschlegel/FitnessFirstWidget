import asyncio
import json
from collections import defaultdict

import aiohttp
from aiohttp import ClientTimeout
from bs4 import BeautifulSoup
from tqdm.asyncio import tqdm

BASE_URL = "https://www.fitnessfirst.de"


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
        url_to_names[a['href']].add(a.get_text(strip=True))

    # Only keep URLs with "Club auswählen" and another actual name
    sanitized_clubs = [
        [url.replace("/clubs/", ""), next(n for n in names if n != "Club auswählen")]
        for url, names in url_to_names.items()
        if "Club auswählen" in names and len(names) > 1
    ]
    return sanitized_clubs


async def fetch_club_id(session, sem, club_url_id, club_name):
    async with sem:
        url = f"{BASE_URL}/clubs/{club_url_id}"
        html = await fetch_html(session, url)
        if not html:
            return None

        soup = BeautifulSoup(html, "html.parser")
        section = soup.find("section", class_="show-club-checkin")
        if section and section.has_attr("data-club"):
            return {
                "name": club_name,
                "url_id": club_url_id,
                "usage_id": section["data-club"]
            }
        print(f"ID not found for {club_name}")
        return None


async def main():
    sem = asyncio.Semaphore(20)  # Limit concurrent requests
    timeout = ClientTimeout(total=30)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        club_list = await fetch_club_list(session)
        
        tasks = [
            fetch_club_id(session, sem, club_url_id, club_name)
            for club_url_id, club_name in club_list
        ]

        results = []
        for r in tqdm(asyncio.as_completed(tasks), total=len(tasks)):
            res = await r
            if res:
                results.append(res)

    # Save to JSON
    with open("clubs.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"Extracted {len(results)} clubs. Saved to clubs.json.")


if __name__ == "__main__":
    asyncio.run(main())
