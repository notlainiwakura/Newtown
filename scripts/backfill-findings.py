#!/usr/bin/env python3
"""Backfill RESOLVED markers in findings.md for known-done P2 anchors.

For each commit whose subject matches `(findings.md P2:<N>)`, this tool:
  1. Reads docs/audit/findings.md as of the commit's PARENT (so the line
     number in the subject is still valid).
  2. Walks back from that line to find the governing `## P2 —` heading.
  3. Grep's CURRENT findings.md for that exact heading text — the content
     doesn't change between commits, only line numbers shift.
  4. Appends ' — RESOLVED' to the heading and inserts a '**Resolution
     (commit SHA):** <subject>' line just before the closing `---`.

Idempotent: skips headings already marked RESOLVED/DEFERRED/PARTIAL.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FINDINGS = ROOT / "docs" / "audit" / "findings.md"
FINDINGS_REL = "docs/audit/findings.md"

ANCHOR_RE = re.compile(r"\(findings\.md P2:(\d+)\)")


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def commits_with_anchors() -> list[tuple[str, str, int]]:
    """Return (sha, subject, anchor_line) for commits tagged with a P2 anchor."""
    raw = git("log", "--all", "--format=%H%x09%s", "--grep=findings.md P2")
    out = []
    for line in raw.strip().splitlines():
        sha, subject = line.split("\t", 1)
        m = ANCHOR_RE.search(subject)
        if not m:
            continue
        out.append((sha, subject, int(m.group(1))))
    return out


# Initial commit that added docs/audit/findings.md. Many fix commits predate
# this commit (they fixed bugs that the audit later documented), so their
# anchor numbers have to be resolved against this first-version file.
FIRST_AUDIT_SHA = "5459afba5b1e7689bb8996b84271d5808748bff4"


def heading_at_anchor(sha: str, anchor_line: int) -> str | None:
    """Get the governing '## P2 —' heading that covers anchor_line in the
    parent of <sha>. If findings.md didn't exist yet, fall back to the
    commit's own tree, then to the first commit that added the audit file."""
    content = None
    for ref in (f"{sha}^:{FINDINGS_REL}", f"{sha}:{FINDINGS_REL}", f"{FIRST_AUDIT_SHA}:{FINDINGS_REL}"):
        try:
            content = git("show", ref)
            break
        except subprocess.CalledProcessError:
            continue
    if content is None:
        return None
    lines = content.splitlines()
    if anchor_line < 1 or anchor_line > len(lines):
        return None
    # Walk backwards from anchor_line to find the enclosing ## P2 heading.
    for j in range(anchor_line - 1, -1, -1):
        if lines[j].startswith("## P2 —") or lines[j].startswith("## P2 ("):
            return lines[j]
    return None


def find_in_current(heading: str, current_lines: list[str]) -> int | None:
    """Return the line index in current findings.md that matches heading
    (ignoring an already-appended ' — RESOLVED' / '— DEFERRED' / '— PARTIAL'
    suffix). Returns None if not found or ambiguous."""
    stripped = re.sub(r"\s*—\s*(RESOLVED|DEFERRED|PARTIAL).*$", "", heading).strip()
    hits = [
        i
        for i, ln in enumerate(current_lines)
        if (ln.startswith("## P2 —") or ln.startswith("## P2 ("))
        and re.sub(r"\s*—\s*(RESOLVED|DEFERRED|PARTIAL).*$", "", ln).strip() == stripped
    ]
    if len(hits) != 1:
        return None
    return hits[0]


def main() -> int:
    text = FINDINGS.read_text()
    lines = text.splitlines(keepends=False)

    commits = commits_with_anchors()
    print(f"found {len(commits)} commits with P2 anchors")

    # Build (heading_idx_current, sha, subject) for each resolvable commit.
    resolutions: list[tuple[int, str, str, str]] = []  # (heading_idx, sha, subject, heading_text)
    skipped_marked = 0
    unresolved: list[tuple[str, str, int, str]] = []  # reason, sha, anchor, subject

    for sha, subject, anchor in commits:
        heading = heading_at_anchor(sha, anchor)
        if heading is None:
            unresolved.append(("no-heading-at-anchor", sha, anchor, subject))
            continue
        idx = find_in_current(heading, lines)
        if idx is None:
            unresolved.append(("no-match-in-current", sha, anchor, subject))
            continue
        # Skip if this heading line in current file already carries a marker.
        if any(m in lines[idx] for m in ("RESOLVED", "DEFERRED", "PARTIAL")):
            skipped_marked += 1
            continue
        # Skip if one already scheduled for this heading (take the first, which
        # is the newest commit since `git log` is newest-first).
        if any(r[0] == idx for r in resolutions):
            continue
        resolutions.append((idx, sha[:8], subject, lines[idx]))

    # Apply from bottom to top.
    resolutions.sort(key=lambda r: -r[0])
    applied = 0
    for heading_idx, sha, subject, heading_text in resolutions:
        # Find closing `---`.
        hr_idx = None
        for j in range(heading_idx + 1, len(lines)):
            if lines[j].strip() == "---":
                hr_idx = j
                break
        if hr_idx is None:
            continue
        # Strip the trailing "(findings.md P2:NNNN)" from the subject.
        clean = re.sub(r"\s*\(findings\.md P2:\d+\)\s*$", "", subject).strip()
        resolution_line = f"**Resolution (commit {sha}):** {clean}."
        lines[heading_idx] = heading_text + " — RESOLVED"
        lines.insert(hr_idx, "")
        lines.insert(hr_idx, resolution_line)
        applied += 1

    FINDINGS.write_text("\n".join(lines) + "\n")

    print(f"annotated: {applied}")
    print(f"already marked (skipped): {skipped_marked}")
    print(f"unresolved: {len(unresolved)}")
    for reason, sha, anchor, subject in unresolved[:15]:
        print(f"  [{reason}] {sha[:8]} P2:{anchor} -- {subject}")
    if len(unresolved) > 15:
        print(f"  ... and {len(unresolved) - 15} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
