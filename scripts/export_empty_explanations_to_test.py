from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path.cwd()
SOURCE_ROOT = ROOT / "data" / "drv-topics"
TARGET_ROOT = ROOT / "data" / "test"


def read_json(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def copy_image(source_root: Path, image_rel_path: str, target_root: Path) -> str:
    source_path = source_root / image_rel_path
    if not source_path.exists():
        return ""

    target_path = target_root / image_rel_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_path, target_path)
    return image_rel_path


def is_empty_explanation(item: dict) -> bool:
    return not str(item.get("explanation", "")).strip()


def export_language(language: str) -> None:
    lang_root = SOURCE_ROOT / language
    for topic_dir in sorted(path for path in lang_root.iterdir() if path.is_dir()):
        items = read_json(topic_dir / "questions.json")
        with_image_items: list[dict] = []
        without_image_items: list[dict] = []

        for item in items:
            if not is_empty_explanation(item):
                continue

            item_copy = dict(item)
            if str(item.get("image", "")).strip():
                target_topic_root = TARGET_ROOT / language / "with-image" / topic_dir.name
                copied_image = copy_image(topic_dir, item["image"], target_topic_root)
                item_copy["image"] = copied_image
                with_image_items.append(item_copy)
            else:
                target_topic_root = TARGET_ROOT / language / "without-image" / topic_dir.name
                without_image_items.append(item_copy)

        if with_image_items:
            write_json(
                TARGET_ROOT / language / "with-image" / topic_dir.name / "questions.json",
                with_image_items,
            )

        if without_image_items:
            write_json(
                TARGET_ROOT / language / "without-image" / topic_dir.name / "questions.json",
                without_image_items,
            )


def main() -> None:
    reset_dir(TARGET_ROOT)

    for language in ("ru", "am"):
        export_language(language)

    print(f"Exported empty-explanation questions to {TARGET_ROOT}")


if __name__ == "__main__":
    main()
