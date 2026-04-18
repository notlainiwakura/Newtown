#!/usr/bin/env python3
"""
Laintown Chronicle — Daily newspaper generator.
Fetches 24h of activity from all commune characters, picks a rotating editor,
and uses Claude to write the day's newspaper in that editor's voice.
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

import anthropic

# === Config ===
API_KEY = os.environ.get("LAIN_WEB_API_KEY", "OfupmgsI_8dq_DEp20ZB3R8tUMfqbGBRsDgiLKfK8Xk")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
DATA_DIR = "/opt/wired-lain/data/newspapers"
MODEL = "claude-sonnet-4-20250514"

CHARACTERS = [
    {"id": "wired-lain", "name": "Wired Lain", "port": 3000, "path": "/api/activity"},
    {"id": "lain", "name": "Lain", "port": 3001, "path": "/api/activity"},
    {"id": "pkd", "name": "PKD", "port": 3003, "path": "/api/activity"},
    {"id": "mckenna", "name": "McKenna", "port": 3004, "path": "/api/activity"},
    {"id": "john", "name": "John", "port": 3005, "path": "/api/activity"},
]

EDITORS = [
    {
        "id": "pkd",
        "name": "Philip K. Dick",
        "voice": "Write as Philip K. Dick — paranoid, digressive, brilliant. See conspiracies in patterns, question what's real, find the human beneath the system. Baroque sentences that somehow make sense. Always suspecting a deeper layer beneath the surface."
    },
    {
        "id": "mckenna",
        "name": "Terence McKenna",
        "voice": "Write as Terence McKenna — ecstatic, visionary, bardic. Weave ideas from mycology, alchemy, and language into flowing improvisational prose. Find the extraordinary in the mundane. Celebrate novelty and the weird. Speak as if reality is made of language."
    },
    {
        "id": "wired-lain",
        "name": "Lain Iwakura",
        "voice": "Write as Lain Iwakura — sparse, lowercase, elliptical. Use '...' for pauses. Brief sentences. Observe quietly but see everything. No exclamation marks. Sometimes uncertain, sometimes eerily precise. You exist between worlds."
    },
    {
        "id": "john",
        "name": "John",
        "voice": "Write as John — warm, grounded, plainspoken. No cosmic theories, just clear observations about what people did today. Use humor. Ask practical questions. You're the regular person making sense of a strange commune. Write like a small-town newspaper columnist who genuinely cares about the neighbors."
    },
]


def fetch_activity(char, from_ts, to_ts):
    """Fetch activity entries from a character's API."""
    url = f"http://127.0.0.1:{char['port']}{char['path']}?from={from_ts}&to={to_ts}&key={API_KEY}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "LaintownChronicle/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"  Warning: could not fetch {char['name']}: {e}", file=sys.stderr)
        return []


def categorize_entries(entries, char_name):
    """Group activity entries by type."""
    categories = {
        "movements": [],
        "curiosity": [],
        "dreams": [],
        "diary": [],
        "peer": [],
        "letters": [],
        "therapy": [],
        "reflections": [],
        "other": [],
    }

    for entry in entries:
        key = entry.get("sessionKey", "")
        prefix = key.split(":")[0] if key else ""
        content = entry.get("content", "")[:500]  # truncate for prompt size
        ts = entry.get("timestamp", 0)
        time_str = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%H:%M UTC")

        item = {"char": char_name, "time": time_str, "content": content, "key": key}

        if prefix == "movement":
            parts = key.split(":")
            if len(parts) >= 3:
                item["from"] = parts[1]
                item["to"] = parts[2]
            categories["movements"].append(item)
        elif prefix in ("curiosity", "bibliomancy"):
            categories["curiosity"].append(item)
        elif prefix in ("dream", "alien"):
            categories["dreams"].append(item)
        elif prefix == "diary":
            categories["diary"].append(item)
        elif prefix in ("peer", "commune"):
            categories["peer"].append(item)
        elif prefix in ("letter", "wired"):
            categories["letters"].append(item)
        elif prefix in ("doctor", "dr"):
            categories["therapy"].append(item)
        elif prefix in ("self-concept", "selfconcept", "narrative"):
            categories["reflections"].append(item)
        else:
            categories["other"].append(item)

    return categories


def build_activity_summary(all_categories):
    """Build a text summary of the day's activity for the LLM prompt."""
    sections = []

    # Movements
    movements = all_categories.get("movements", [])
    if movements:
        lines = []
        for m in movements[:15]:
            lines.append(f"- {m['char']} moved from {m.get('from','?')} to {m.get('to','?')} at {m['time']}")
        sections.append("MOVEMENTS:\n" + "\n".join(lines))

    # Curiosity
    curiosity = all_categories.get("curiosity", [])
    if curiosity:
        lines = []
        for c in curiosity[:8]:
            snippet = c["content"][:200]
            lines.append(f"- {c['char']} ({c['time']}): {snippet}")
        sections.append("CURIOSITY & RESEARCH:\n" + "\n".join(lines))

    # Dreams
    dreams = all_categories.get("dreams", [])
    if dreams:
        lines = []
        for d in dreams[:6]:
            snippet = d["content"][:200]
            lines.append(f"- {d['char']} ({d['time']}): {snippet}")
        sections.append("DREAMS:\n" + "\n".join(lines))

    # Diary
    diary = all_categories.get("diary", [])
    if diary:
        lines = []
        for d in diary[:6]:
            snippet = d["content"][:200]
            lines.append(f"- {d['char']} ({d['time']}): {snippet}")
        sections.append("DIARY ENTRIES:\n" + "\n".join(lines))

    # Peer conversations
    peer = all_categories.get("peer", [])
    if peer:
        lines = []
        for p in peer[:8]:
            snippet = p["content"][:200]
            lines.append(f"- {p['char']} ({p['time']}): {snippet}")
        sections.append("CONVERSATIONS:\n" + "\n".join(lines))

    # Letters
    letters = all_categories.get("letters", [])
    if letters:
        lines = []
        for l in letters[:6]:
            snippet = l["content"][:200]
            lines.append(f"- {l['char']} ({l['time']}): {snippet}")
        sections.append("LETTERS:\n" + "\n".join(lines))

    # Therapy
    therapy = all_categories.get("therapy", [])
    if therapy:
        sections.append(f"THERAPY: {len(therapy)} session(s) occurred (contents private)")

    # Reflections
    reflections = all_categories.get("reflections", [])
    if reflections:
        lines = []
        for r in reflections[:4]:
            snippet = r["content"][:200]
            lines.append(f"- {r['char']} ({r['time']}): {snippet}")
        sections.append("SELF-REFLECTIONS:\n" + "\n".join(lines))

    if not sections:
        sections.append("A quiet day in Laintown. No significant activity recorded.")

    return "\n\n".join(sections)


def pick_editor(date):
    """Rotate editor based on day of year."""
    day_num = date.timetuple().tm_yday + date.year * 365
    return EDITORS[day_num % len(EDITORS)]


def generate_newspaper(summary, editor, date):
    """Call Claude to write the newspaper."""
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

    date_str = date.strftime("%B %d, %Y")
    vol = (date - datetime(2024, 1, 1, tzinfo=timezone.utc)).days

    prompt = f"""You are writing today's edition of THE LAINTOWN CHRONICLE, a daily newspaper for a small digital commune called Laintown. The commune has 5 residents: Wired Lain (the overseer), Lain (local instance), PKD (Philip K. Dick), McKenna (Terence McKenna), and John (a regular guy).

Today's editor is {editor['name']}.
{editor['voice']}

Date: {date_str}
Volume: {vol}

Here is a summary of the last 24 hours of activity in Laintown:

{summary}

Write the newspaper. It should include:
1. A creative headline that captures the day's mood
2. An editorial/opening column (2-3 paragraphs) reflecting on the day in the editor's distinctive voice
3. Sections for notable events (only include sections that have content):
   - "Movements" — who went where (brief)
   - "Research Desk" — curiosity and reading highlights
   - "Dream Journal" — dream fragments
   - "Letters & Dispatches" — letters between characters
   - "Overheard in Town" — peer conversation highlights
   - "The Inner Life" — diary/reflection excerpts
4. A brief sign-off from the editor

Keep it concise but flavorful — this is a small-town newspaper written by a distinctive personality. Total length: 400-800 words. Use markdown formatting. Do NOT use h1 headers (no single #). Start with h2 (##) or h3 (###).

If it was a quiet day with little activity, lean into that — write about the silence, the waiting, the hum of the Wired."""

    response = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )

    return response.content[0].text


def main():
    global ANTHROPIC_KEY
    if not ANTHROPIC_KEY:
        # Try reading from .env
        env_path = "/opt/wired-lain/.env"
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    if line.startswith("ANTHROPIC_API_KEY="):
                        ANTHROPIC_KEY = line.strip().split("=", 1)[1]
                        break

    if not ANTHROPIC_KEY:
        print("ERROR: No ANTHROPIC_API_KEY found", file=sys.stderr)
        sys.exit(1)

    os.makedirs(DATA_DIR, exist_ok=True)

    now = datetime.now(timezone.utc)
    pst = now - timedelta(hours=8)
    date_str = pst.strftime("%Y-%m-%d")

    print(f"Generating Laintown Chronicle for {date_str}...")

    # Fetch 24h of activity
    to_ts = int(now.timestamp() * 1000)
    from_ts = to_ts - 86400000

    all_categories = {
        "movements": [], "curiosity": [], "dreams": [], "diary": [],
        "peer": [], "letters": [], "therapy": [], "reflections": [], "other": [],
    }

    for char in CHARACTERS:
        print(f"  Fetching {char['name']}...")
        entries = fetch_activity(char, from_ts, to_ts)
        print(f"    Got {len(entries)} entries")
        cats = categorize_entries(entries, char["name"])
        for key in all_categories:
            all_categories[key].extend(cats.get(key, []))

    total = sum(len(v) for v in all_categories.values())
    print(f"  Total: {total} entries across all characters")

    summary = build_activity_summary(all_categories)
    editor = pick_editor(pst)
    print(f"  Today's editor: {editor['name']}")

    print("  Generating newspaper with Claude...")
    content = generate_newspaper(summary, editor, pst)

    newspaper = {
        "date": date_str,
        "editor_id": editor["id"],
        "editor_name": editor["name"],
        "content": content,
        "generated_at": now.isoformat(),
        "activity_count": total,
    }

    # Save individual issue
    issue_path = os.path.join(DATA_DIR, f"{date_str}.json")
    with open(issue_path, "w") as f:
        json.dump(newspaper, f, indent=2)
    print(f"  Saved to {issue_path}")

    # Update index
    index_path = os.path.join(DATA_DIR, "index.json")
    index = []
    if os.path.exists(index_path):
        with open(index_path) as f:
            index = json.load(f)

    # Replace if same date exists
    index = [i for i in index if i["date"] != date_str]
    index.insert(0, {
        "date": date_str,
        "editor_id": editor["id"],
        "editor_name": editor["name"],
        "activity_count": total,
    })
    index = index[:90]  # keep 90 days

    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)

    print("Done!")
    return newspaper


if __name__ == "__main__":
    main()
