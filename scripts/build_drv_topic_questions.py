from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path.cwd()
IMPORT_ROOT = ROOT / "data" / "imports" / "drv"
OUTPUT_ROOT = ROOT / "data" / "drv-topics"

GROUP_TOPICS = {
    1: "maneuvers-and-lane-position",
    2: "terms-and-general-rules",
    3: "vehicle-technical-condition",
    4: "road-signs",
    5: "intersection-priority",
    6: "traffic-lights-and-intersections",
    7: "stopping-parking-and-markings",
    8: "speed-towing-and-passengers",
    9: "overtaking-signals-and-railway-crossings",
    10: "first-aid",
}


def clean_text(value: object) -> str:
    return " ".join(str(value or "").replace("\u00a0", " ").split())


def fix_text(value: object) -> str:
    text = clean_text(value)
    if not text:
        return ""

    try:
        return text.encode("cp1251").decode("utf-8")
    except Exception:
        return text


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def ensure_empty_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def option_id(index: int) -> str:
    return chr(ord("a") + index)


def build_entity_refs() -> list[dict]:
    return [
        {"type": "sign", "ids": []},
        {"type": "marking", "ids": []},
    ]


def normalize_options(item: dict) -> list[dict]:
    detailed = item.get("optionsDetailed")
    if isinstance(detailed, list) and detailed:
        return detailed

    options = item.get("options") or []
    correct_option = item.get("correctOption")
    normalized = []

    for index, text in enumerate(options):
        normalized.append(
            {
                "index": index,
                "text": text,
                "isCorrect": text == correct_option,
            }
        )

    return normalized


def copy_image(source_path: str | None, destination_path: Path) -> None:
    if not source_path:
        return

    source = Path(source_path)
    if not source.exists():
        return

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination_path)


def build_language_group(group_number: int, language: str) -> tuple[str, int]:
    topic_folder = GROUP_TOPICS[group_number]
    folder_name = f"group-{group_number}" if language == "ru" else f"group-{group_number}-am"
    data = read_json(IMPORT_ROOT / folder_name / "questions.json")
    items = data.get("items") or []

    output_dir = OUTPUT_ROOT / language / topic_folder
    images_dir = output_dir / "images"
    output_dir.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(parents=True, exist_ok=True)

    normalized_items = []

    for index, item in enumerate(items, start=1):
        options_raw = normalize_options(item)
        correct_index = next(
            (i for i, option in enumerate(options_raw) if option.get("isCorrect")),
            -1,
        )
        if correct_index < 0:
            raise ValueError(f"{language} group-{group_number} item {index} has no correct option")

        image_source = item.get("imagePath")
        image_relative_path = ""
        if image_source:
            image_ext = Path(image_source).suffix or ".jpg"
            image_name = f"{index:03d}{image_ext}"
            copy_image(image_source, images_dir / image_name)
            image_relative_path = f"images/{image_name}"

        options = []
        for option_index, option in enumerate(options_raw):
            options.append(
                {
                    "id": option_id(option_index),
                    "text": fix_text(option.get("text", "")),
                }
            )

        normalized_items.append(
            {
                "id": f"{group_number}-{index}",
                "group": str(group_number),
                "question": fix_text(item.get("question", "")),
                "options": options,
                "correctOptionId": option_id(correct_index),
                "image": image_relative_path,
                "entityRefs": build_entity_refs(),
                "explanation": fix_text(item.get("explanation", "")),
                "comment": "",
            }
        )

    (output_dir / "questions.json").write_text(
        json.dumps(normalized_items, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    return topic_folder, len(normalized_items)


def main() -> None:
    ensure_empty_dir(OUTPUT_ROOT)

    for language in ("ru", "am"):
        for group_number in range(1, 11):
            topic_folder, count = build_language_group(group_number, language)
            print(f"{language} group-{group_number} -> {topic_folder}: {count} questions")

    print(f"Saved normalized topic folders to {OUTPUT_ROOT}")


if __name__ == "__main__":
    main()
