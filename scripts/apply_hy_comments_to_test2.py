from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path.cwd()
TARGET_ROOT = ROOT / "data" / "test" / "test2" / "am"
PATCH_ROOT = TARGET_ROOT / "_comments_patch"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: list[dict]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_hy_comments() -> dict[str, str]:
    comments: dict[str, str] = {}

    generated_path = PATCH_ROOT / "comments_hy.json"
    if generated_path.exists():
        comments.update(read_json(generated_path))

    override_path = PATCH_ROOT / "comments_hy_override.json"
    if override_path.exists():
        comments.update(read_json(override_path))

    return comments


def has_cyrillic(text: str) -> bool:
    return bool(re.search(r"[А-Яа-яЁё]", text))


def strip_cyrillic(text: str) -> str:
    cleaned = re.sub(r"\([^)]*[А-Яа-яЁё][^)]*\)", "", text)
    cleaned = cleaned.replace("Подвох", "Լոծում")
    cleaned = re.sub(r"[А-Яа-яЁё]+", "", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def main() -> None:
    hy_comments = load_hy_comments()
    updated = 0
    still_russian = 0
    empty = 0

    for path in sorted(TARGET_ROOT.rglob("questions.json")):
        items = read_json(path)
        changed: list[dict] = []

        for item in items:
            updated_item = dict(item)
            comment = strip_cyrillic(str(hy_comments.get(item["id"], "")).strip())
            if comment:
                updated_item["comment"] = comment
                if comment != item.get("comment"):
                    updated += 1
                if has_cyrillic(comment):
                    still_russian += 1
            else:
                updated_item["comment"] = ""
                empty += 1
            changed.append(updated_item)

        write_json(path, changed)

    print(f"Updated comments: {updated}")
    print(f"Still with Cyrillic: {still_russian}")
    print(f"Empty comments: {empty}")


if __name__ == "__main__":
    main()