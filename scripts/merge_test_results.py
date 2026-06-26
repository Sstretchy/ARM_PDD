from __future__ import annotations

import json
from pathlib import Path


ROOT = Path.cwd()
SOURCE_ROOT = ROOT / "data" / "drv-topics"
TEST_ROOT = ROOT / "data" / "test"


def read_json(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: list[dict]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def merge_language(language: str) -> tuple[int, int, list[Path]]:
    source_lang_root = SOURCE_ROOT / language
    test_lang_root = TEST_ROOT / language
    updated_topics = 0
    updated_items = 0
    skipped_files: list[Path] = []

    if not test_lang_root.exists():
        return updated_topics, updated_items, skipped_files

    for bucket_dir in sorted(path for path in test_lang_root.iterdir() if path.is_dir()):
        for topic_dir in sorted(path for path in bucket_dir.iterdir() if path.is_dir()):
            source_path = source_lang_root / topic_dir.name / "questions.json"
            test_path = topic_dir / "questions.json"

            if not source_path.exists() or not test_path.exists():
                continue

            source_items = read_json(source_path)
            try:
                test_items = read_json(test_path)
            except json.JSONDecodeError:
                skipped_files.append(test_path)
                continue
            test_by_id = {item["id"]: item for item in test_items}

            topic_changes = 0
            merged_items: list[dict] = []
            for source_item in source_items:
                test_item = test_by_id.get(source_item["id"])
                if test_item is None:
                    merged_items.append(source_item)
                    continue

                merged_item = dict(source_item)
                merged_item.update(test_item)
                if merged_item != source_item:
                    topic_changes += 1
                merged_items.append(merged_item)

            if topic_changes:
                write_json(source_path, merged_items)
                updated_topics += 1
                updated_items += topic_changes

    return updated_topics, updated_items, skipped_files


def main() -> None:
    total_topics = 0
    total_items = 0
    total_skipped: list[Path] = []

    for language in sorted(path.name for path in TEST_ROOT.iterdir() if path.is_dir()):
        updated_topics, updated_items, skipped_files = merge_language(language)
        total_topics += updated_topics
        total_items += updated_items
        total_skipped.extend(skipped_files)
        print(
            f"{language}: updated {updated_items} questions across {updated_topics} topics"
        )
        for skipped_file in skipped_files:
            print(f"{language}: skipped invalid JSON {skipped_file}")

    print(f"Done: updated {total_items} questions across {total_topics} topics")


if __name__ == "__main__":
    main()
