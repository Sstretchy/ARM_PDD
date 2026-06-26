from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path.cwd()
SOURCE_ROOT = ROOT / "data" / "drv-topics" / "am"
TARGET_ROOT = ROOT / "data" / "test2" / "am"


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


def has_explanation(item: dict) -> bool:
    return bool(str(item.get("explanation", "")).strip())


def strip_comment(item: dict) -> dict:
    item_copy = dict(item)
    item_copy.pop("comment", None)
    return item_copy


def export_topics() -> tuple[int, int]:
    topic_count = 0
    item_count = 0

    for topic_dir in sorted(path for path in SOURCE_ROOT.iterdir() if path.is_dir()):
        source_path = topic_dir / "questions.json"
        if not source_path.exists():
            continue

        items = read_json(source_path)
        with_image_items: list[dict] = []
        without_image_items: list[dict] = []

        for item in items:
            if not has_explanation(item):
                continue

            item_copy = strip_comment(item)
            image_rel_path = str(item.get("image", "")).strip()

            if image_rel_path:
                target_topic_root = TARGET_ROOT / "with-image" / topic_dir.name
                item_copy["image"] = copy_image(topic_dir, image_rel_path, target_topic_root)
                with_image_items.append(item_copy)
            else:
                target_topic_root = TARGET_ROOT / "without-image" / topic_dir.name
                without_image_items.append(item_copy)

        if with_image_items:
            write_json(
                TARGET_ROOT / "with-image" / topic_dir.name / "questions.json",
                with_image_items,
            )
            topic_count += 1
            item_count += len(with_image_items)

        if without_image_items:
            write_json(
                TARGET_ROOT / "without-image" / topic_dir.name / "questions.json",
                without_image_items,
            )
            topic_count += 1
            item_count += len(without_image_items)

    return topic_count, item_count


def main() -> None:
    reset_dir(TARGET_ROOT)
    topic_count, item_count = export_topics()
    print(f"Exported {item_count} questions across {topic_count} topic buckets to {TARGET_ROOT}")


if __name__ == "__main__":
    main()
