import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
ru = json.loads(
    (root / "data/test/test2/am/_comments_patch/maneuvers-and-lane-position.json").read_text(
        encoding="utf-8"
    )
)
files = [
    root / "data/test/test2/am/with-image/maneuvers-and-lane-position/questions.json",
    root / "data/test/test2/am/without-image/maneuvers-and-lane-position/questions.json",
]
questions = {}
for f in files:
    for q in json.loads(f.read_text(encoding="utf-8")):
        questions[q["id"]] = q

ids = sorted(questions.keys(), key=lambda x: (int(x.split("-")[0]), int(x.split("-")[1])))
lines = []
for qid in ids:
    q = questions[qid]
    opts = {o["id"]: o["text"] for o in q["options"]}
    lines.append(f"=== {qid} ===")
    lines.append(f"Q: {q['question']}")
    lines.append(f"OK: {opts[q['correctOptionId']]}")
    lines.append(f"RU: {ru[qid]['comment']}")
    lines.append("")

out = root / "data/test/test2/am/_comments_patch/_maneuvers_full.txt"
out.write_text("\n".join(lines), encoding="utf-8")
print("done", len(ids))