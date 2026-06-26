from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path.cwd()
TARGET_ROOT = ROOT / "data" / "test" / "test2" / "am"
PATCH_ROOT = TARGET_ROOT / "_comments_patch"
RU_ROOT = ROOT / "data" / "drv-topics" / "ru"

SIGNS_IDS = set(json.loads((ROOT / "data" / "signs_ids.json").read_text(encoding="utf-8")))
MARKING_IDS = set(json.loads((ROOT / "data" / "marking_ids.json").read_text(encoding="utf-8")))
TERMS = json.loads((ROOT / "data" / "terms.json").read_text(encoding="utf-8"))

SIGN_PATTERN = re.compile(r"(?<!\d)(?:[1-8]\.\d+(?:\.\d+){0,2})(?!\d)")
MARKING_PATTERN = re.compile(r"(?<!\d)(?:1\.\d+(?:\.\d+)?|2\.\d+(?:\.\d+)?)(?!\d)")


def read_json(path: Path) -> list[dict] | dict:
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
    return sorted(found, key=lambda value: (value.count("."), value))


def strip_sign_spans(text: str, sign_ids: list[str]) -> str:
    cleaned = text
    for sign_id in sorted(sign_ids, key=len, reverse=True):
        cleaned = cleaned.replace(sign_id, " ")
    return cleaned


def extract_marking_ids(text: str, sign_ids: list[str] | None = None) -> list[str]:
    source = strip_sign_spans(text, sign_ids or extract_sign_ids(text))
    found: list[str] = []
    for match in MARKING_PATTERN.findall(source):
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


def sanitize_marking_ids(sign_ids: list[str], marking_ids: list[str]) -> list[str]:
    cleaned: list[str] = []
    for marking_id in marking_ids:
        if marking_id not in MARKING_IDS:
            continue
        if any(
            marking_id in sign_id and marking_id != sign_id for sign_id in sign_ids
        ):
            continue
        if marking_id not in cleaned:
            cleaned.append(marking_id)
    return cleaned


def normalize_entity_refs(item: dict, patch_refs: list[dict] | None = None) -> list[dict]:
    text = combined_text(item)
    sign_ids = extract_sign_ids(text)
    if patch_refs:
        for sign_id in patch_refs[0].get("ids", []):
            if sign_id in SIGNS_IDS and sign_id not in sign_ids:
                sign_ids.append(sign_id)

    marking_ids = extract_marking_ids(text, sign_ids)
    if patch_refs:
        for marking_id in patch_refs[1].get("ids", []):
            if marking_id in MARKING_IDS and marking_id not in marking_ids:
                marking_ids.append(marking_id)

    marking_ids = sanitize_marking_ids(sign_ids, marking_ids)

    term_ids = extract_term_slugs(text)
    if patch_refs and len(patch_refs) > 2:
        for term_id in patch_refs[2].get("ids", []):
            if term_id not in term_ids:
                term_ids.append(term_id)

    return [
        {"type": "sign", "ids": sign_ids},
        {"type": "marking", "ids": marking_ids},
        {"type": "term", "ids": term_ids},
    ]


def texts_are_similar(a: str, b: str) -> bool:
    a_norm = re.sub(r"\s+", " ", a.strip().casefold())
    b_norm = re.sub(r"\s+", " ", b.strip().casefold())
    if not a_norm or not b_norm:
        return False
    return a_norm == b_norm or a_norm in b_norm or b_norm in a_norm


def load_ru_by_image(topic: str) -> dict[str, str]:
    path = RU_ROOT / topic / "questions.json"
    if not path.exists():
        return {}
    mapping: dict[str, str] = {}
    for item in read_json(path):
        image = str(item.get("image", "")).strip()
        comment = str(item.get("comment", "")).strip()
        if image and comment:
            mapping[image] = comment
    return mapping


def road_signs_hint(item: dict) -> str:
    exp = item.get("explanation", "")
    if "7.16" in exp or "խոնավ" in exp:
        return "Табличка про влажное покрытие — лимит действует только когда дорога мокрая, а не при любом плохом покрытии."
    if "2.5" in exp or "Կանգ" in exp:
        return "STOP без стоп-линии: остановка у края пересекаемой проезжей части, а не у самого знака."
    if "2.4" in exp:
        return "«Уступите дорогу» — можно ехать без полной остановки, если никому не мешаешь. Не путай со STOP."
    if "3.27" in exp or "3.28" in exp:
        return "3.27 запрещает остановку, 3.28 — стоянку. Остановка короче 5 минут с пассажирами — не стоянка."
    if "1.15" in exp or "50" in exp and "100" in exp:
        return "В населённом пункте предупреждающий знак ставят за 50–100 м до опасности — не прямо перед ней."
    if "6.9" in exp or "6.10" in exp or "6.11" in exp:
        return "Запрет разворота/обгона на знаках 6.9–6.11 действует на участке между парными знаками."
    if "8." in exp:
        return "Табличка меняет смысл основного знака — сначала найди табличку, потом читай знак."
    return "Сначала определи тип знака: предупреждающий, запрещающий или предписывающий — от этого зависит, что именно обязан сделать водитель."


def load_all_patches() -> dict[str, dict]:
    patches: dict[str, dict] = {}
    for path in sorted(PATCH_ROOT.glob("*.json")):
        if path.name in {"comments_ru.json", "hy_ru_translations.json", "hy_comments.json"}:
            continue
        data = read_json(path)
        if isinstance(data, dict):
            patches.update(data)
    return patches


def ensure_road_signs_patch(patches: dict[str, dict]) -> None:
    ru_by_image = load_ru_by_image("road-signs")
    for bucket in ("with-image", "without-image"):
        path = TARGET_ROOT / bucket / "road-signs" / "questions.json"
        if not path.exists():
            continue
        for item in read_json(path):
            question_id = item["id"]
            if question_id in patches and str(patches[question_id].get("comment", "")).strip():
                continue

            comment = ""
            image = str(item.get("image", "")).strip()
            if image:
                ru_comment = ru_by_image.get(image, "")
                if ru_comment and not texts_are_similar(ru_comment, item.get("explanation", "")):
                    comment = ru_comment

            if not comment:
                comment = road_signs_hint(item)

            patches[question_id] = {
                "comment": comment,
                "entityRefs": normalize_entity_refs(item),
            }


def apply_patches() -> tuple[int, int, int]:
    patches = load_all_patches()
    ensure_road_signs_patch(patches)

    updated_comments = 0
    updated_refs = 0
    still_empty = 0

    for path in sorted(TARGET_ROOT.rglob("questions.json")):
        items = read_json(path)
        changed_items: list[dict] = []

        for item in items:
            updated = dict(item)
            patch = patches.get(item["id"])

            if patch:
                new_comment = str(patch.get("comment", "")).strip()
                if new_comment and not texts_are_similar(new_comment, item.get("explanation", "")):
                    if updated.get("comment") != new_comment:
                        updated["comment"] = new_comment
                        updated_comments += 1
                elif not new_comment:
                    updated["comment"] = ""
                    still_empty += 1
                else:
                    updated["comment"] = road_signs_hint(item) if "road-signs" in str(path) else ""

                new_refs = normalize_entity_refs(item, patch.get("entityRefs"))
                if new_refs != updated.get("entityRefs"):
                    updated["entityRefs"] = new_refs
                    updated_refs += 1
            else:
                updated["entityRefs"] = normalize_entity_refs(item)
                if not str(updated.get("comment", "")).strip():
                    still_empty += 1

            if "comment" not in updated:
                updated["comment"] = ""

            changed_items.append(updated)

        write_json(path, changed_items)

    return updated_comments, updated_refs, still_empty


def main() -> None:
    updated_comments, updated_refs, still_empty = apply_patches()
    print(f"Updated comments: {updated_comments}")
    print(f"Updated entityRefs: {updated_refs}")
    print(f"Still empty comments: {still_empty}")


if __name__ == "__main__":
    main()