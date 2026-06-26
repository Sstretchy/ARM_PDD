from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path.cwd()
TARGET_ROOT = ROOT / "data" / "test" / "test2" / "am"
SIGNS_IDS = set(json.loads((ROOT / "data" / "signs_ids.json").read_text(encoding="utf-8")))
MARKING_IDS = set(json.loads((ROOT / "data" / "marking_ids.json").read_text(encoding="utf-8")))
TERMS = json.loads((ROOT / "data" / "terms.json").read_text(encoding="utf-8"))

SIGN_PATTERN = re.compile(
    r"(?<!\d)(?:[1-8]\.\d+(?:\.\d+){0,2})(?!\d)"
)
MARKING_PATTERN = re.compile(
    r"(?<!\d)(?:1\.\d+(?:\.\d+)?|2\.\d+(?:\.\d+)?)(?!\d)"
)


def read_json(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: list[dict]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def build_term_patterns() -> list[tuple[str, str, str]]:
    patterns: list[tuple[str, str, str]] = []
    for term in TERMS:
        slug = term["slug"]
        for field in ("term_ru", "term_hy"):
            text = str(term.get(field, "")).strip()
            if len(text) >= 4:
                patterns.append((slug, field, text))
    patterns.sort(key=lambda item: len(item[2]), reverse=True)
    return patterns


TERM_PATTERNS = build_term_patterns()


def extract_sign_ids(text: str) -> list[str]:
    found: list[str] = []
    for match in SIGN_PATTERN.findall(text):
        if match in SIGNS_IDS and match not in found:
            found.append(match)
    return found


def extract_marking_ids(text: str) -> list[str]:
    found: list[str] = []
    for match in MARKING_PATTERN.findall(text):
        if match in MARKING_IDS and match not in found:
            found.append(match)
    return found


def extract_term_slugs(text: str) -> list[str]:
    lowered = text.casefold()
    found: list[str] = []
    for slug, field, term_text in TERM_PATTERNS:
        if term_text.casefold() in lowered and slug not in found:
            found.append(slug)
    return found


def normalize_entity_refs(combined_text: str) -> list[dict]:
    return [
        {"type": "sign", "ids": extract_sign_ids(combined_text)},
        {"type": "marking", "ids": extract_marking_ids(combined_text)},
        {"type": "term", "ids": extract_term_slugs(combined_text)},
    ]


def combined_text(item: dict) -> str:
    parts = [item.get("question", ""), item.get("explanation", "")]
    for option in item.get("options", []):
        parts.append(option.get("text", ""))
    return "\n".join(parts)


def texts_are_similar(a: str, b: str) -> bool:
    a_norm = re.sub(r"\s+", " ", a.strip().casefold())
    b_norm = re.sub(r"\s+", " ", b.strip().casefold())
    if not a_norm or not b_norm:
        return False
    return a_norm == b_norm or a_norm in b_norm or b_norm in a_norm


def main() -> None:
    print(
        "Use scripts/apply_test2_am_comments_patch.py to enrich test2/am comments and entityRefs."
    )


if __name__ == "__main__":
    main()