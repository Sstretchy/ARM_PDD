from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET_ROOT = ROOT / "data" / "test" / "test2" / "am"
PATCH_ROOT = TARGET_ROOT / "_comments_patch"
RU_ROOT = ROOT / "data" / "drv-topics" / "ru"
AM_ROOT = ROOT / "data" / "drv-topics" / "am"

SIGNS_IDS = set(json.loads((ROOT / "data" / "signs_ids.json").read_text(encoding="utf-8")))
MARKING_IDS = set(json.loads((ROOT / "data" / "marking_ids.json").read_text(encoding="utf-8")))
TERMS = json.loads((ROOT / "data" / "terms.json").read_text(encoding="utf-8"))

SIGN_PATTERN = re.compile(r"(?<!\d)(?:[1-8]\.\d+(?:\.\d+){0,2})(?!\d)")
MARKING_PATTERN = re.compile(r"(?<!\d)(?:1\.\d+(?:\.\d+)?|2\.\d+(?:\.\d+)?)(?!\d)")

TOPIC_FILES = [
    ("first-aid", "without-image"),
    ("vehicle-technical-condition", "without-image"),
    ("traffic-lights-and-intersections", "with-image"),
    ("traffic-lights-and-intersections", "without-image"),
    ("stopping-parking-and-markings", "with-image"),
    ("stopping-parking-and-markings", "without-image"),
    ("speed-towing-and-passengers", "with-image"),
    ("speed-towing-and-passengers", "without-image"),
    ("overtaking-signals-and-railway-crossings", "with-image"),
    ("overtaking-signals-and-railway-crossings", "without-image"),
    ("terms-and-general-rules", "with-image"),
    ("terms-and-general-rules", "without-image"),
]


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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


def combined_text(item: dict) -> str:
    parts = [item.get("question", ""), item.get("explanation", "")]
    for option in item.get("options", []):
        parts.append(option.get("text", ""))
    return "\n".join(parts)


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
    for slug, _field, term_text in TERM_PATTERNS:
        if term_text.casefold() in lowered and slug not in found:
            found.append(slug)
    return found


def normalize_entity_refs(item: dict) -> list[dict]:
    text = combined_text(item)
    return [
        {"type": "sign", "ids": extract_sign_ids(text)},
        {"type": "marking", "ids": extract_marking_ids(text)},
        {"type": "term", "ids": extract_term_slugs(text)},
    ]


def texts_are_similar(a: str, b: str) -> bool:
    a_norm = re.sub(r"\s+", " ", a.strip().casefold())
    b_norm = re.sub(r"\s+", " ", b.strip().casefold())
    if not a_norm or not b_norm:
        return False
    return a_norm == b_norm or a_norm in b_norm or b_norm in a_norm


NUMERIC_PATTERN = re.compile(r"\d+(?:\.\d+)?")


def numeric_fingerprint(item: dict) -> tuple[str, int, tuple[str, ...]]:
    text = combined_text(item)
    numbers = tuple(sorted(set(NUMERIC_PATTERN.findall(text))))
    return item.get("correctOptionId", ""), len(item.get("options", [])), numbers


def load_comment_sources() -> tuple[
    dict[str, str],
    dict[tuple[str, str], str],
    dict[str, dict[tuple[str, int, tuple[str, ...]], list[str]]],
]:
    overrides_path = PATCH_ROOT / "comments_ru.json"
    overrides: dict[str, str] = {}
    if overrides_path.exists():
        overrides = read_json(overrides_path)

    ru_by_image: dict[tuple[str, str], str] = {}
    ru_by_numeric: dict[str, dict[tuple[str, int, tuple[str, ...]], list[str]]] = {}
    for topic_dir in RU_ROOT.iterdir():
        if not topic_dir.is_dir():
            continue
        questions_path = topic_dir / "questions.json"
        if not questions_path.exists():
            continue
        topic = topic_dir.name
        ru_by_numeric[topic] = {}
        for item in read_json(questions_path):
            image = str(item.get("image", "")).strip()
            comment = str(item.get("comment", "")).strip()
            if image and comment:
                ru_by_image[(topic, image)] = comment
            if comment:
                key = numeric_fingerprint(item)
                ru_by_numeric[topic].setdefault(key, []).append(comment)

    return overrides, ru_by_image, ru_by_numeric


def resolve_comment(
    item: dict,
    topic: str,
    overrides: dict[str, str],
    ru_by_image: dict[tuple[str, str], str],
    ru_by_numeric: dict[str, dict[tuple[str, int, tuple[str, ...]], list[str]]],
) -> str:
    question_id = item["id"]

    if question_id in overrides:
        comment = overrides[question_id].strip()
        if comment and not texts_are_similar(comment, item.get("explanation", "")):
            return comment

    image = str(item.get("image", "")).strip()
    if image:
        ru_comment = ru_by_image.get((topic, image), "").strip()
        if ru_comment and not texts_are_similar(ru_comment, item.get("explanation", "")):
            return ru_comment

    numeric_key = numeric_fingerprint(item)
    numeric_candidates = ru_by_numeric.get(topic, {}).get(numeric_key, [])
    unique_comments = []
    for candidate in numeric_candidates:
        cleaned = candidate.strip()
        if cleaned and cleaned not in unique_comments:
            unique_comments.append(cleaned)
    if len(unique_comments) == 1 and not texts_are_similar(
        unique_comments[0], item.get("explanation", "")
    ):
        return unique_comments[0]

    import sys

    scripts_dir = str(ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from generate_comments_ru import translate_hy

    return translate_hy(
        question_id,
        "",
        topic,
        item.get("explanation", ""),
        item.get("correctOptionId", ""),
    )


def patch_file_name(topic: str, bucket: str) -> str:
    bucket_suffix = "with-image" if bucket == "with-image" else "without-image"
    return f"{topic}__{bucket_suffix}.json"


def main() -> None:
    overrides, ru_by_image, ru_by_numeric = load_comment_sources()
    PATCH_ROOT.mkdir(parents=True, exist_ok=True)

    total = 0
    patches: dict[str, dict] = {}

    for topic, bucket in TOPIC_FILES:
        questions_path = TARGET_ROOT / bucket / topic / "questions.json"
        items = read_json(questions_path)
        patch_name = patch_file_name(topic, bucket)
        patch_payload: dict[str, dict] = {}

        for item in items:
            comment = resolve_comment(item, topic, overrides, ru_by_image, ru_by_numeric)
            entity_refs = normalize_entity_refs(item)
            patch_payload[item["id"]] = {
                "comment": comment,
                "entityRefs": entity_refs,
            }
            total += 1

        patches[patch_name] = patch_payload
        write_json(PATCH_ROOT / patch_name, patch_payload)

    print(f"Wrote {total} question patches across {len(patches)} files to {PATCH_ROOT}")


if __name__ == "__main__":
    main()