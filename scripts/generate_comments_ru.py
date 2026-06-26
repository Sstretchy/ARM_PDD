from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATCH_ROOT = ROOT / "data" / "test" / "test2" / "am" / "_comments_patch"

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


def extract_russian_bits(text: str) -> str:
    parts = re.findall(r"[А-Яа-яЁё][^։\.!\n]*[\.!?]", text)
    return " ".join(part.strip() for part in parts if part.strip())


def vehicle_hint(exp: str, correct: str) -> str:
    if "երկու դեպքում էլ" in exp or "երկու դեպքն էլ" in exp or "թվարկած բոլոր դեպքերում" in exp:
        return "Каждый перечисленный дефект сам по себе запрещает эксплуатацию — правильный ответ «оба/все случаи», а не один из них."
    if "միայն" in exp and correct != "c" and correct != "d":
        return "В Перечне неисправностей запрет часто касается только одного пункта. Не выбирай «во всех случаях», если остальные варианты формально допустимы."
    if "1,6 մմ" in exp or "1.6" in exp:
        return "Для легкового минимальный остаток протектора обычно 1,6 мм. Меньше — эксплуатация запрещена."
    if "0,8 մմ" in exp or "0.8" in exp:
        return "Для мотоцикла минимум протектора 0,8 мм. 0,6 мм уже ниже нормы."
    if "2,0 մմ" in exp or "2.0" in exp:
        return "У автобуса минимальный остаток протектора выше — 2,0 мм."
    if "10°" in exp or "10 °" in exp:
        return "Следи за допустимым люфтом руля: у разных категорий разные пределы, часто 10° или 20°."
    if "ձայնային ազդանշանի" in exp:
        return "Неисправный звуковой сигнал — самостоятельный повод запретить эксплуатацию."
    if "լուսանդրադարձ" in exp or "լապտեր" in exp:
        return "Цвет и режим световых приборов важны: спереди обычно белый/жёлтый, сзади — красный. Другой цвет часто означает неисправность."
    if "ամրագոտ" in exp:
        return "Ремни безопасности и их исправность — отдельный обязательный пункт Перечня."
    if "դեղատուփ" in exp or "կրակմարիչ" in exp:
        return "Аптечка, огнетушитель и знак аварийной остановки для нужных категорий — не «приятное дополнение», а условие допуска."
    return "Сверяй каждый вариант с Перечнем неисправностей: часто запрещён только один конкретный дефект, а не все сразу."


def terms_hint(exp: str) -> str:
    if "մայթ" in exp:
        return "Тротуар — это элемент дороги для пешеходов: он может примыкать к проезжей части или быть отделён от неё."
    if "բնակավայր" in exp:
        return "Населённый пункт начинается и заканчивается знаками, а не количеством домов вокруг."
    if "խաչմերուկ" in exp and "հարող" in exp:
        return "Выезд с прилегающей территории перекрёстком не считается — это отдельный, более простой режим."
    if "750" in exp or "800" in exp or "1000" in exp:
        return "Для категорий B, C и D с прицепом смотри лимит по массе прицепа — на экзамене важны точные цифры."
    if "300" in exp and "տեսանելիություն" in exp:
        return "Недостаточная видимость — про погоду и дальность до 300 м, а не просто про ночь."
    return "Термины в ПДД формулируются юридически точно: ориентируйся на определение из закона, а не на бытовой смысл слова."


def first_aid_hint(exp: str, correct: str) -> str:
    if "գլխի վնասվածք" in exp:
        return "При травме головы ноги не поднимают — лучше положение с чуть приподнятой головой и плечами."
    if "տրիաժ" in exp or "անգիտակից" in exp and "առաջին" in exp:
        return "При нескольких пострадавших сначала помогают тому, у кого угроза жизни прямо сейчас — чаще всего без сознания."
    if "սրտի" in exp or "կորոնար" in exp:
        return "При подозрении на инфаркт нельзя продолжать ехать или давать случайные лекарства — остановись и вызови помощь."
    if "էպիստաքսիս" in exp or "քթից" in exp:
        return "При носовом кровотечении сажают, наклоняют голову вперёд и давят на мягкую часть носа — не запрокидывают голову."
    return "В первой помощи главное — не навреди: сначала безопасность, потом простые действия по алгоритму."


def stopping_hint(exp: str) -> str:
    if "կայանում" in exp and "կանգառ" in exp:
        return "Стоянка дольше 5 минут строже обычной остановки: смотри знаки, разметку и расстояния до перекрёстка."
    if "նարնջագույն" in exp:
        return "Оранжевая разметка временная и важнее белой, если они противоречат друг другу."
    if "ընդհատվող" in exp:
        return "Прерывистая линия не всегда запрещает манёвр — смотри её тип и соседние знаки."
    return "Перед остановкой или стоянкой сначала проверь знаки и разметку, а не только удобство места."


def speed_hint(exp: str) -> str:
    if "միջքաղաքային" in exp and "90" in exp:
        return "Междугородний автобус вне населённого пункта может ехать до 90 км/ч — не путай с обычным автобусом."
    if "60" in exp and "բնակավայր" in exp:
        return "В населённом пункте для всех, включая автобусы, базовый предел — 60 км/ч."
    if "50" in exp and "քարշակ" in exp:
        return "При буксировке на гибкой сцепке лимит — 50 км/ч, даже если дорога хорошая."
    if "110" in exp:
        return "110 км/ч — не для всех: обычно только легковые на автомагистрали."
    return "Скорость зависит от типа ТС, дороги и условий — не переноси один лимит на все ситуации."


def overtaking_hint(exp: str) -> str:
    if "վազանց" in exp and "խաչմերուկ" in exp:
        return "Обгон на перекрёстке, у моста и Ж/Д переезда — отдельные запреты, даже если дорога кажется свободной."
    if "փարոսիկ" in exp or "սիրենա" in exp:
        return "Синий или красный маячок со звуком — уступи дорогу и при необходимости остановись."
    if "ազդանշան" in exp and "նախօրոք" in exp:
        return "Поворотник включают заранее, а не в момент манёвра."
    if "ձախ ձեռք" in exp:
        return "Вытянутая влево рука из окна означает поворот налево."
    if "երկաթուղային" in exp:
        return "У Ж/Д переезда нельзя обходить шлагбаум и спорить со светофором — жди разрешения."
    return "Перед обгоном оцени видимость, встречку и запреты — при сомнении лучше не обгонять."


def traffic_hint(exp: str) -> str:
    if "կարգավորող" in exp:
        return "Жест регулировщика важнее светофора: сначала пойми, с какой стороны ты стоишь относительно его груди и спины."
    if "տրամվայ" in exp:
        return "Трамвай имеет преимущество не всегда, а когда ему тоже разрешено движение своим сигналом."
    if "լրացուցիչ" in exp and "սլաք" in exp:
        return "Дополнительная секция светофора действует только на свой проезд — не переноси стрелку на следующий цикл."
    return "На перекрёстке смотри не только свой свет, но и сигналы других участников, особенно трамвая и регулировщика."


HY_RU: dict[str, str] = {
    "10-1": "Многие думают, что масло или крем помогут при ожоге, но жир держит тепло и усиливает повреждение. Вскрывать пузыри опасно. Охладить и закрыть — самый безопасный вариант.",
    "10-2": "Не поднимай конечность и не вытаскивай инородное тело — сначала закрой рану и обездвижь.",
    "10-3": "При травме груди удобнее сидеть, наклонившись на больную сторону, а не лежать горизонтально.",
    "10-4": "Инородное тело из раны не вынимают — фиксируют и ждут врачей.",
    "10-5": "При подозрении на внутреннее кровотечение не поят и не греют живот — покой и холод.",
    "10-6": "Если в гараже угар, сначала проветри и обесточь, а не бросайся к человеку.",
    "10-7": "Помогать при кровотечении можно — нужны перчатки и защита от прямого контакта.",
    "10-8": "Сначала перчатки и повязка, а не промывание йодом при активном кровотечении.",
    "10-9": "Из машины выносят, если внутри опаснее: пожар, взрыв, нет дыхания и нельзя помочь на месте.",
    "10-10": "Норма дыхания взрослого в покое — 12–18 вдохов в минуту.",
    "10-11": "Вытаскивают из салона, когда снаружи реально опаснее, а не при любой травме.",
    "10-12": "Сильное кровотечение останавливают давлением, а не только повязкой.",
    "10-13": "Выпавшие органы не вправляют — накрывают влажной чистой тканью.",
    "10-14": "Нормальный пульс в покое — 60–80 ударов в минуту.",
    "10-15": "После долгой работы в наклоне при обмороке подними ноги, а не сажай и не бей по щеке.",
    "10-16": "При артериальном кровотечении подними конечность и наложи давящую повязку.",
    "10-17": "Первый шаг при ДТП — безопасность места для себя и пострадавших.",
    "10-18": "Если обеспечить безопасность нельзя — не подходи, вызови помощь и не пускай других.",
    "10-19": "Сначала сознание и дыхание, потом всё остальное.",
    "10-20": "Дышащего без сознания кладут на бок, чтобы не захлебнуться.",
    "10-21": "Струя яркой крови — тревожный признак, реагируй быстро.",
    "10-22": "Сначала дыхательные пути и проверка дыхания, не вода и не положение на бок без оценки.",
    "10-23": "При астме удобнее полусидя.",
    "10-24": "При боли в животе помогают согнутые колени.",
    "10-25": "После жгута проверь кровоток по цвету ногтя.",
    "10-26": "Лекарства при оказании первой помощи не дают.",
    "10-27": "Если машина под током, выходить из неё опасно.",
    "10-28": "При обмороке подними ноги.",
    "10-29": "При потере сознания, но сохранном дыхании — устойчивое положение на боку.",
    "10-30": "Артериальное кровотечение опознают по яркой пульсирующей струе.",
    "10-31": "В экстренный вызов нужны точные детали, а не общие слова «была авария».",
    "10-32": "При переохлаждении согревают постепенно, без трения снегом и алкоголя.",
    "10-33": "При ране головы важны давление на рану и положение на боку.",
    "10-34": "При кровотечении сначала останови кровь, потом промывай.",
    "10-35": "Без запрокидывания головы проверка дыхания мало что даст.",
    "10-36": "При подозрении на позвоночник не поворачивай человека без нужды.",
    "10-37": "Высота кузова меняет, какие травмы получает пешеход.",
    "10-38": "Жгут нужен не всегда — часто хватает давящей повязки.",
    "10-39": "В рану не льют спирт — для мелких ран лучше вода с мылом.",
    "10-40": "После ушиба сначала холод и покой, не тепло.",
    "10-41": "Перелом иммобилизуют с мягкой прокладкой, не на прямую натянутую конечность.",
    "10-42": "Пузыри при ожоге не вскрывают.",
    "10-43": "При судорогах не держи человека силой и не вставляй предметы в рот.",
    "10-47": "Жгут нельзя оставлять надолго — записывай время.",
    "10-48": "Сначала убери источник тока, потом помогай.",
    "10-49": "При низком сахаре у диабетика опаснее инсулин, чем сладкое в сознании.",
    "10-51": "У ребёнка при наезде чаще страдают голова и грудь.",
}


def translate_hy(question_id: str, hy_text: str, topic: str, exp: str, correct: str) -> str:
    hy_ru = load_hy_ru()
    if question_id in hy_ru:
        return hy_ru[question_id]
    ru_bits = extract_russian_bits(hy_text)
    if ru_bits:
        return ru_bits
    if topic == "vehicle-technical-condition":
        return vehicle_hint(exp, correct)
    if topic == "terms-and-general-rules":
        return terms_hint(exp)
    if topic == "first-aid":
        return first_aid_hint(exp, correct)
    if topic == "stopping-parking-and-markings":
        return stopping_hint(exp)
    if topic == "speed-towing-and-passengers":
        return speed_hint(exp)
    if topic == "overtaking-signals-and-railway-crossings":
        return overtaking_hint(exp)
    if topic == "traffic-lights-and-intersections":
        return traffic_hint(exp)
    return "Смотри на главное правило вопроса и типичную ошибку новичка — не переписывай длинное объяснение, а найди один запрет или один обязательный шаг."


NUMERIC_PATTERN = re.compile(r"\d+(?:\.\d+)?")


def numeric_fingerprint(item: dict) -> tuple[str, int, tuple[str, ...]]:
    text = "\n".join(
        [
            item.get("question", ""),
            item.get("explanation", ""),
            *[option.get("text", "") for option in item.get("options", [])],
        ]
    )
    numbers = tuple(sorted(set(NUMERIC_PATTERN.findall(text))))
    return item.get("correctOptionId", ""), len(item.get("options", [])), numbers


def load_ru_comment_sources() -> tuple[dict[tuple[str, str], str], dict[str, dict]]:
    ru_by_image: dict[tuple[str, str], str] = {}
    ru_by_numeric: dict[str, dict[tuple[str, int, tuple[str, ...]], list[str]]] = {}
    ru_root = ROOT / "data" / "drv-topics" / "ru"
    for topic_dir in ru_root.iterdir():
        if not topic_dir.is_dir():
            continue
        questions_path = topic_dir / "questions.json"
        if not questions_path.exists():
            continue
        topic = topic_dir.name
        ru_by_numeric[topic] = {}
        for item in read_json(questions_path):
            comment = str(item.get("comment", "")).strip()
            if not comment:
                continue
            image = str(item.get("image", "")).strip()
            if image:
                ru_by_image[(topic, image)] = comment
            key = numeric_fingerprint(item)
            ru_by_numeric[topic].setdefault(key, []).append(comment)
    return ru_by_image, ru_by_numeric


def texts_are_similar(a: str, b: str) -> bool:
    a_norm = re.sub(r"\s+", " ", a.strip().casefold())
    b_norm = re.sub(r"\s+", " ", b.strip().casefold())
    if not a_norm or not b_norm:
        return False
    return a_norm == b_norm or a_norm in b_norm or b_norm in a_norm


def resolve_from_ru(item: dict, topic: str, ru_by_image, ru_by_numeric) -> str:
    image = str(item.get("image", "")).strip()
    if image:
        comment = ru_by_image.get((topic, image), "").strip()
        if comment and not texts_are_similar(comment, item.get("explanation", "")):
            return comment
    numeric_key = numeric_fingerprint(item)
    candidates = ru_by_numeric.get(topic, {}).get(numeric_key, [])
    unique: list[str] = []
    for candidate in candidates:
        cleaned = candidate.strip()
        if cleaned and cleaned not in unique:
            unique.append(cleaned)
    if len(unique) == 1 and not texts_are_similar(unique[0], item.get("explanation", "")):
        return unique[0]
    return ""


def load_hy_ru() -> dict[str, str]:
    merged = dict(HY_RU)
    extra_path = PATCH_ROOT / "hy_ru_translations.json"
    if extra_path.exists():
        merged.update(read_json(extra_path))
    return merged


def main() -> None:
    hy_comments = read_json(PATCH_ROOT / "hy_comments.json")
    global HY_RU
    HY_RU = load_hy_ru()
    ru_by_image, ru_by_numeric = load_ru_comment_sources()
    am_by_id: dict[str, tuple[str, dict]] = {}
    for topic, _bucket in TOPIC_FILES:
        am_path = ROOT / "data" / "drv-topics" / "am" / topic / "questions.json"
        if not am_path.exists():
            continue
        for item in read_json(am_path):
            am_by_id[item["id"]] = (topic, item)

    comments: dict[str, str] = {}
    for question_id, hy_text in hy_comments.items():
        topic, am_item = am_by_id.get(question_id, ("", {}))
        comments[question_id] = translate_hy(
            question_id,
            hy_text,
            topic,
            am_item.get("explanation", ""),
            am_item.get("correctOptionId", ""),
        )

    write_json(PATCH_ROOT / "comments_ru.json", comments)
    print(f"Wrote {len(comments)} comments to {PATCH_ROOT / 'comments_ru.json'}")


if __name__ == "__main__":
    main()