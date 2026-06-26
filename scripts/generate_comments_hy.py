from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET_ROOT = ROOT / "data" / "test" / "test2" / "am"
PATCH_ROOT = TARGET_ROOT / "_comments_patch"
AM_ROOT = ROOT / "data" / "drv-topics" / "am"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def texts_are_similar(a: str, b: str) -> bool:
    a_norm = re.sub(r"\s+", " ", a.strip().casefold())
    b_norm = re.sub(r"\s+", " ", b.strip().casefold())
    if not a_norm or not b_norm:
        return False
    return a_norm == b_norm or a_norm in b_norm or b_norm in a_norm


def extract_trap_hint(exp: str) -> str:
    match = re.search(r"«([^»]{4,120})»[^.]{0,80}սխալ", exp)
    if match:
        trap = match.group(1).strip()
        return (
            f"Սովորական լոծումը՝ «{trap}» տարբերակը։ "
            "Նայիր հենց այն բառին կամ պայմանին, որը հարցում տարբերում է ճիշտ պատասխանը։"
        )
    return ""


def vehicle_hint(exp: str, correct: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "երկու դեպքում էլ" in exp or "երկու դեպքն էլ" in exp or "թվարկած բոլոր դեպքերում" in exp:
        return "Յուրաքանչյուր նշված անսարքություն ինքնուրույն կարող է արգելել շահագործումը — «երկուսն էլ» կամ «բոլորը» հաճախ ճիշտ է։"
    if "1,6 մմ" in exp or "1.6" in exp:
        return "Թեթև մարդատարի համար նվազագույն պահպանվածությունը սովորաբար 1,6 մմ է։ Ավելի քիչը արդեն արգելք է։"
    if "0,8 մմ" in exp or "0.8" in exp:
        return "Մոտոցիկլի համար նվազագույն պահպանվածությունը 0,8 մմ է — 0,6 մմ արդեն քիչ է։"
    if "2,0 մմ" in exp or "2.0" in exp:
        return "Ավտոբուսի համար պահպանվածության նվազագույնը ավելի բարձր է՝ 2,0 մմ։"
    if "ձայնային ազդանշանի" in exp:
        return "Չաշխատող ձայնային ազդանշանը ինքնուրույն արգելք է — մի մոռացիր ստուգել այն։"
    if "լուսանդրադարձ" in exp or "լապտեր" in exp:
        return "Լույսի գույնը կարևոր է՝ առջևում սովորաբար սպիտակ/դեղին, հետևում՝ կարմիր։ Այլ գույնը հաճախ անսարքություն է։"
    if "ամրագոտ" in exp:
        return "Անվտանգության գոտիները և դրանց աշխատանքը առանձին պարտադիր պայման են։"
    if "դեղատուփ" in exp or "կրակմարիչ" in exp:
        return "Ապտեքա, կրակմարիչ և ավարիայի նշանը որոշ կատեգորիաների համար պարտադիր են, ոչ թե «լավ է ունենալ»։"
    return "Յուրաքանչյուր տարբերակ համեմատիր անսարքությունների ցանկի հետ — հաճախ արգելվում է միայն մեկ կոնկրետ դեպքը։"


def terms_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "մայթ" in exp:
        return "Մայթը հետիոտների տարր է և կարող է հարակից լինել կամ առանձնացված երթևեկելի մասից։"
    if "բնակավայր" in exp:
        return "Բնակավայրը սկսվում և ավարտվում է նշաններով, ոչ թե տների քանակով։"
    if "խաչմերուկ" in exp and "հարող" in exp:
        return "Հարող տարածքից դուրս գալը խաչմերուկ չի համարվում — այնտեղ ավելի պարզ կանոններ են գործում։"
    if "750" in exp or "800" in exp or "1000" in exp:
        return "B, C և D կատեգորիաների համար կարևոր են ճշգրիտ թույլատրելի քարշակի զանգվածները։"
    if "300" in exp and "տեսանելիություն" in exp:
        return "Անբավարար տեսանելիությունը մասնավորապես եղանակի և մինչև 300 մ տեսանելիության մասին է, ոչ թե պարզապես գիշերի։"
    return "Պայմանագրային տերմինները հաճախ նեղ են — օրենքի սահմանումը կարևոր է, ոչ թե բնակչության սովորական բառը։"


def first_aid_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "գլխի վնասվածք" in exp:
        return "Գլխի վնասվածքի դեպքում ոտքերը չեն բարձրացնում — ավելի անվտանգ է կիսանստած կամ կողքի դիրք։"
    if "տրիաժ" in exp or ("անգիտակից" in exp and "առաջին" in exp):
        return "Մի քանի տուժածի դեպքում նախ օգնում են այն մեկին, ում կյանքին սպառնում է անմիջական վտանգը։"
    if "սրտի" in exp or "կորոնար" in exp:
        return "Սրտի կասկածի դեպքում չես շարունակում երթևեկությունը և չես տալիս պատահական դեղամիջոցներ։"
    if "էպիստաքսիս" in exp or "քթից" in exp:
        return "Քթի արյունահոսության ժամանակ գլուխը չեն հետ գցում — նստեցնում են և ճնչում մեղմ մասը։"
    return "Առաջին օգնության հիմնական սկզբունքը՝ «չվնասել»։ Նախ անվտանգություն, հետո պարզ քայլեր։"


def stopping_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "կայանում" in exp and "կանգառ" in exp:
        return "Կանգառը 5 րոպեից ավելի է — ստուգիր նշանները, գծանշումը և հեռավորությունը խաչմերուկից։"
    if "նարնջագույն" in exp:
        return "Նարնջագույն գծանշումը ժամանակավոր է և հակասության դեպքում գերակայում է սպիտակին։"
    if "ընդհատվող" in exp:
        return "Ընդհատվող գիծը միշտ չի արգելում մանևրը — նայիր գծի տեսակին և մոտակա նշաններին։"
    return "Կանգառից կամ կայանքից առաջ նախ նշաններն ու գծանշումն են կարևոր, ոչ թե միայն հարմարությունը։"


def speed_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "միջքաղաքային" in exp and "90" in exp:
        return "Միջքաղաքային ավտոբուսը բնակավայրից դուրս կարող է մինչև 90 կմ/ժ — մի շփոթիր սովորական ավտոբուսի 70-ի հետ։"
    if "60" in exp and "բնակավայր" in exp:
        return "Բնակավայրում բոլորի համար, ներառյալ ավտոբուսները, հիմնական սահմանը 60 կմ/ժ է։"
    if "50" in exp and "քարշակ" in exp:
        return "Ճկուն քարշակով բեռնվածքի դեպքում սահմանը 50 կմ/ժ է, նույնիսկ լավ ճանապարհի վրա։"
    if "110" in exp:
        return "110 կմ/ժ-ը բոլորի համար չէ — սովորաբար միայն թեթև մեքենաների համար ավտոմայրուղի վրա։"
    return "Արագությունը կախված է տրանսպորտի տեսակից, ճանապարհից և պայմաններից — մի տարածես մեկ թվանշանը բոլոր իրավիճակների վրա։"


def overtaking_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "վազանց" in exp and "խաչմերուկ" in exp:
        return "Խաչմերուկում, կամրջի և երկաթուղային գծանցի մոտ վազանցը առանձին արգելք է, նույնիսկ եթե ճանապարհը դատարկ է թվում։"
    if "փարոսիկ" in exp or "սիրենա" in exp:
        return "Կապույտ կամ կարմիր փարոսիկը ձայնային ազդանշանով պահանջում է զիջել ճանապարհը և անհրաժեշտության դեպքում կանգ առնել։"
    if "ազդանշան" in exp and "նախօրոք" in exp:
        return "Ցուցիչը միացնում են նախապես, ոչ թե մանևրը սկսելու պահին։"
    if "ձախ ձեռք" in exp:
        return "Ձախ ձեռքը պատուհանից դուրս ազդանշան է ձախ շրջադարձի մասին։"
    if "երկաթուղային" in exp:
        return "Երկաթուղային գծանցում չես շրջանցում արգելափակը և չես վիճում ազդանշանի հետ — սպասում ես թույլտվության։"
    return "Վազանցից առաջ գնահատիր տեսանելիությունը, հանդիպակացին և արգելքները — կասկածի դեպքում լավ է չվազանցել։"


def traffic_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "կարգավորող" in exp:
        return "Կարգավորողի ժեստը կարևոր է լուսացույցից — նախ հասկացիր, թե դու նրա դիմաց ես, թե մեջքին։"
    if "տրամվայ" in exp:
        return "Տրամվայն առավելություն ունի ոչ միշտ, այլ երբ իր ազդանշանով նույնպես թույլատրված է երթևեկությունը։"
    if "լրացուցիչ" in exp and "սլաք" in exp:
        return "Լրացուցիչ սլաքը գործում է միայն իր ուղղությամբ — մի կիրառես հաջորդ ցիկլի համար։"
    return "Խաչմերուկում նայիր ոչ միայն քո լույսին, այլև տրամվայի և կարգավորողի ազդանշաններին։"


def maneuvers_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "5.5" in exp or "միակողմանի" in exp:
        return "5.5 նշանը միակողմանի երթևեկություն է — այնտեղ հետադարձը միշտ արգելված է։"
    if "100 մ" in exp or "100մ" in exp:
        return "Հետադարձի համար պետք է լինի առնվազն 100 մ տեսանելիություն երկու ուղղությամբ — «չեմ խանգարում» բավարար չէ։"
    if "հետիոտ" in exp and "հեծանվորդ" in exp:
        return "Դուրս գալիս հարող տարածքից զիջում ես և հետիոտներին, և երթևեկողներին։"
    if "ձախ" in exp and "շրջադարձ" in exp and "զիջ" in exp:
        return "Ձախ շրջադարձի ժամանակ հաճախ պետք է զիջել հանդիպակացին և խաչմերուկի մյուս մասնակիցներին։"
    if "հետադարձ" in exp and "խաչմերուկ" in exp:
        return "Խաչմերուկում հետադարձը հաճախ արգելված է կամ պահանջում է առանձին պայմաններ։"
    if "պահանջ" in exp and "գոտի" in exp:
        return "Մանևրից առաջ զբաղեցրու համապատասխան եզրային գոտին — դա հաճախ պատասխանի բանալին է։"
    return "Մանևրի հարցերում նախ գտիր, թե ով սկսում է երթևեկությունը կամ փոխում է գոտին, հետո արդեն ընտրիր պատասխանը։"


def intersection_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "2.1" in exp or "գլխավոր" in exp:
        return "2.1-ը գլխավոր ճանապարհ է — երկրորդականից եկողները պետք է զիջեն։"
    if "2.4" in exp:
        return "2.4-ը «Զիջիր ճանապարհը» է — կանգառ պարտադիր չէ, եթե ոչ միին չես խանգարում։"
    if "2.5" in exp:
        return "2.5 STOP-ն է — կանգառը պարտադիր է, նախ «Կանգ» գծի մոտ, այլապես՝ հատման եզրին։"
    if "4.3" in exp or "կլորացում" in exp or "կլոր" in exp:
        return "Կլորացման խաչմերուկում ներս մտնողը զիջում է արդեն կլորի վրա եղողներին։"
    if "աջ" in exp and ("խոչընդոտ" in exp or "զիջ" in exp):
        return "Հավասարազոր խաչմերուկում հաճախ գործում է «աջից խոչընդոտ» կանոնը։"
    return "Առաջնությունը որոշում են նշանները, լուսացույցը, կարգավորողը, հետո՝ հավասարազորության կանոնները։"


def road_signs_hint(exp: str) -> str:
    trap = extract_trap_hint(exp)
    if trap:
        return trap
    if "7.16" in exp or "խոնավ" in exp:
        return "7.16 ստեղնը նշանակում է, որ սահմանափակումը գործում է միայն խոնավ ծածկույթի դեպքում, ոչ թե սառցի կամ ձյան։"
    if "2.5" in exp or "Կանգ" in exp:
        return "STOP-ի դեպքում, եթե «Կանգ» գիծ չկա, կանգառը հատվող երթևեկելի մասի եզրին է, ոչ թե նշանի տակ։"
    if "2.4" in exp:
        return "«Զիջիր ճանապարհը»-ն STOP չէ — կարող ես անցնել, եթե ոչ մեկին չես խանգարում։"
    if "3.27" in exp or "3.28" in exp:
        return "3.27-ը արգելում է կանգառը, 3.28-ը՝ կայանքը։ 5 րոպեից կարճ դադարը հաճախ կանգառ է, ոչ կայանք։"
    if "50" in exp and "100" in exp and "նախազգուշացնող" in exp:
        return "Բնակավայրում նախազգուշացնող նշանը սովորաբար դրվում է վտանգից 50–100 մ առաջ, ոչ թե ուղիղ դրա դիմաց։"
    if "6.9" in exp or "6.10" in exp or "6.11" in exp:
        return "6.9–6.11 նշանների միջև գործում է արգելքը — մի տես միայն մեկ նշանը։"
    if "8." in exp:
        return "Ստեղնը փոխում է հիմնական նշանի իմաստը — նախ գտիր ստեղնը, հետո կարդա նշանը։"
    return "Նախ պարզիր նշանի խումբը՝ նախազգուշացնող, արգելող թե պարտադրող, հետո մտածիր, թե ինչ պետք է անես դու որպես վարորդ։"


def topic_hint(topic: str, exp: str, correct: str) -> str:
    if topic == "vehicle-technical-condition":
        return vehicle_hint(exp, correct)
    if topic == "terms-and-general-rules":
        return terms_hint(exp)
    if topic == "first-aid":
        return first_aid_hint(exp)
    if topic == "stopping-parking-and-markings":
        return stopping_hint(exp)
    if topic == "speed-towing-and-passengers":
        return speed_hint(exp)
    if topic == "overtaking-signals-and-railway-crossings":
        return overtaking_hint(exp)
    if topic == "traffic-lights-and-intersections":
        return traffic_hint(exp)
    if topic == "maneuvers-and-lane-position":
        return maneuvers_hint(exp)
    if topic == "intersection-priority":
        return intersection_hint(exp)
    if topic == "road-signs":
        return road_signs_hint(exp)
    return "Նայիր հարցի հիմնական կանոնին և սովորական սխալ տարբերակին — մի պատճենի երկար բացատրությունը, գտիր մեկ հուշում։"


def load_sources() -> tuple[dict[str, str], dict[tuple[str, str], str], dict[str, str]]:
    by_id: dict[str, str] = {}
    by_image: dict[tuple[str, str], str] = {}

    for topic_dir in AM_ROOT.iterdir():
        if not topic_dir.is_dir():
            continue
        questions_path = topic_dir / "questions.json"
        if not questions_path.exists():
            continue
        topic = topic_dir.name
        for item in read_json(questions_path):
            comment = str(item.get("comment", "")).strip()
            if not comment:
                continue
            by_id[item["id"]] = comment
            image = str(item.get("image", "")).strip()
            if image:
                by_image[(topic, image)] = comment

    extra_path = PATCH_ROOT / "hy_comments.json"
    extra: dict[str, str] = read_json(extra_path) if extra_path.exists() else {}
    return by_id, by_image, extra


def resolve_comment(item: dict, topic: str, by_id, by_image, extra) -> str:
    question_id = item["id"]
    explanation = item.get("explanation", "")

    for source in (by_id.get(question_id, ""), extra.get(question_id, "")):
        if source and not texts_are_similar(source, explanation):
            return source

    image = str(item.get("image", "")).strip()
    if image:
        image_comment = by_image.get((topic, image), "")
        if image_comment and not texts_are_similar(image_comment, explanation):
            return image_comment

    generated = topic_hint(topic, explanation, item.get("correctOptionId", ""))
    if generated and not texts_are_similar(generated, explanation):
        return generated

    return generated


def main() -> None:
    by_id, by_image, extra = load_sources()
    comments: dict[str, str] = {}

    for path in sorted(TARGET_ROOT.rglob("questions.json")):
        topic = path.parent.name
        for item in read_json(path):
            comments[item["id"]] = resolve_comment(item, topic, by_id, by_image, extra)

    write_json(PATCH_ROOT / "comments_hy.json", comments)
    print(f"Wrote {len(comments)} Armenian comments to {PATCH_ROOT / 'comments_hy.json'}")


if __name__ == "__main__":
    main()