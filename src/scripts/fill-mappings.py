"""
Pre-populate `nomenclature_mappings` from `onec_nomenclature` using
deterministic rule-based variant generation. No API calls.

For each catalog item produces 5-10 variants covering:
  - identity + lowercase
  - ё ↔ е
  - latin homoglyphs ↔ cyrillic (a/а, c/с, o/о, e/е, p/р, x/х, k/к)
  - strip parenthetical hints  "Молоко (1л)" → "Молоко"
  - strip trailing pack suffix "Молоко 1л"  → "Молоко"
  - common Russian abbreviations (б/к, нат, мол, обыкн, зам, конс, ...)
  - first 1-2 meaningful words

Run: python src/scripts/fill-mappings.py
Reads .env for DB_*.
"""
from __future__ import annotations
import os, re, sys
from pathlib import Path

# Load .env
env_path = Path('.env')
for line in env_path.read_text(encoding='utf-8').splitlines():
    m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line)
    if m and m.group(1) not in os.environ:
        os.environ[m.group(1)] = m.group(2)

import pymysql

# ---------------- safety guard ----------------
DB_HOST = os.environ['DB_HOST']
DB_NAME = os.environ['DB_NAME']
if DB_HOST not in ('127.0.0.1', 'localhost'):
    sys.exit(f'Refusing non-local DB_HOST={DB_HOST}')

# ---------------- variant rules ----------------

# Latin → Cyrillic for visually-identical letters. Bi-directional.
LATIN_TO_CYR = str.maketrans('aAcCeEoOpPxXkKHTM3yy', 'аАсСеЕоОрРхХкКНТМЗуу')
CYR_TO_LATIN = str.maketrans('аАсСеЕоОрРхХкК', 'aAcCeEoOpPxXkK')

# Common abbreviations: full → short. Compiled case-insensitive.
ABBREV = [
    (r'\bбелокочанная\b', 'б/к'),
    (r'\bбелокочанной\b', 'б/к'),
    (r'\bбелокочанный\b', 'б/к'),
    (r'\bкраснокочанная\b', 'кр/к'),
    (r'\bобыкновенн(ый|ая|ое)\b', 'обыкн.'),
    (r'\bмолочн(ый|ая|ое)\b', 'мол.'),
    (r'\bнатуральн(ый|ая|ое)\b', 'нат.'),
    (r'\bсушён(ый|ая|ое)\b', 'суш.'),
    (r'\bсушен(ый|ая|ое)\b', 'суш.'),
    (r'\bзаморозка\b', 'зам.'),
    (r'\bзаморож(енный|енная|енное)\b', 'зам.'),
    (r'\bконсервированн(ый|ая|ое|ые)\b', 'конс.'),
    (r'\bконцентрированн(ый|ая|ое)\b', 'конц.'),
    (r'\bрафинированн(ое|ый|ая)\b', 'раф.'),
    (r'\bнерафинированн(ое|ый|ая)\b', 'нераф.'),
    (r'\bбез косточки\b', 'б/к'),
    (r'\bбез кости\b', 'б/к'),
    (r'\bохлаждённ(ый|ая|ое)\b', 'охл.'),
    (r'\bохлажд(ённ|енн)(ый|ая|ое)\b', 'охл.'),
    (r'\bсвеж(ий|ая|ое)\b', 'свеж.'),
    (r'\bкондитерск(ий|ая|ое)\b', 'конд.'),
    (r'\bбисквитн(ый|ая|ое)\b', 'биск.'),
    (r'\bкокосов(ый|ая|ое)\b', 'кок.'),
    (r'\bподсолнечн(ый|ая|ое)\b', 'подс.'),
    (r'\bсливочн(ый|ая|ое)\b', 'слив.'),
    (r'\bрастительн(ый|ая|ое)\b', 'раст.'),
]
# Build compiled tuples
ABBREV_C = [(re.compile(p, re.IGNORECASE), r) for p, r in ABBREV]

PACK_RE = re.compile(r'\s*\d+[\.,]?\d*\s*(кг|г|гр|л|мл|шт|уп|упак|пач|шт\.)\s*$', re.IGNORECASE)
PAREN_RE = re.compile(r'\s*\([^)]*\)\s*')
MULTI_SPACE = re.compile(r'\s+')


def normalize(s: str) -> str:
    return MULTI_SPACE.sub(' ', s).strip()


def variants_for(name: str) -> list[str]:
    """Return de-duplicated list of plausible variant strings."""
    out: list[str] = []
    seen: set[str] = set()

    def add(v: str) -> None:
        v = normalize(v)
        # filter: empty, too long, too short (<3 chars)
        if not v or len(v) > 500 or len(v) < 3:
            return
        # normalize-key for dedup (case-insensitive, ё=е, latin/cyr collapsed)
        key = v.lower().replace('ё', 'е').translate(LATIN_TO_CYR)
        if key in seen:
            return
        seen.add(key)
        out.append(v)

    # 1. identity
    add(name)
    # 2. lowercase
    add(name.lower())
    # 3. ё → е
    add(name.replace('ё', 'е').replace('Ё', 'Е'))
    add(name.replace('ё', 'е').replace('Ё', 'Е').lower())
    # 4. latin → cyrillic homoglyphs (catches OCR mojibake like "Cалат")
    add(name.translate(LATIN_TO_CYR))
    # 5. strip parenthetical
    no_paren = PAREN_RE.sub(' ', name).strip()
    if no_paren != name:
        add(no_paren)
    # 6. strip trailing pack suffix
    no_pack = PACK_RE.sub('', name).strip()
    if no_pack != name and no_pack:
        add(no_pack)
        add(no_pack.lower())
    # 7. strip both paren AND pack
    stripped = PAREN_RE.sub(' ', name)
    stripped = PACK_RE.sub('', stripped).strip()
    if stripped != name:
        add(stripped)
    # 8. abbreviated forms
    abbr = name
    for pat, repl in ABBREV_C:
        abbr = pat.sub(repl, abbr)
    if abbr != name:
        add(abbr)
        add(abbr.lower())
    # 9. just the first word (when name is multi-word)
    words = re.split(r'\s+', stripped if stripped else name)
    if len(words) >= 2 and len(words[0]) >= 4:
        add(words[0])
    # 10. first two words
    if len(words) >= 3:
        add(' '.join(words[:2]))

    # remove identity itself from the variant list (already exact match,
    # but we DO want it in the mappings table as the most natural form)
    return out


def main() -> int:
    conn = pymysql.connect(
        host=DB_HOST, port=int(os.environ.get('DB_PORT', 3306)),
        user=os.environ['DB_USER'], password=os.environ['DB_PASSWORD'],
        database=DB_NAME, charset='utf8mb4', autocommit=False,
    )
    cur = conn.cursor(pymysql.cursors.DictCursor)
    cur.execute("SELECT guid, name, unit FROM onec_nomenclature WHERE (is_folder=0 OR is_folder IS NULL)")
    items = cur.fetchall()
    print(f'catalog items: {len(items)}')

    # Existing mappings — don't overwrite, just skip on conflict via INSERT IGNORE
    cur.execute("SELECT COUNT(*) AS c FROM nomenclature_mappings")
    before = cur.fetchone()['c']
    print(f'mappings before: {before}')

    total_attempts = 0
    inserted = 0
    skipped = 0
    sql = (
        "INSERT IGNORE INTO nomenclature_mappings "
        "(scanned_name, mapped_name_1c, default_unit, approved, onec_guid, times_seen) "
        "VALUES (%s, %s, %s, 1, %s, 0)"
    )
    sample_lines: list[str] = []
    for it in items:
        vs = variants_for(it['name'])
        if len(sample_lines) < 5:
            sample_lines.append(f'  {it["name"]!r} → {vs}')
        for v in vs:
            total_attempts += 1
            try:
                cur.execute(sql, (v, it['name'], it['unit'], it['guid']))
                if cur.rowcount > 0:
                    inserted += 1
                else:
                    skipped += 1
            except pymysql.err.DataError as e:
                skipped += 1
    conn.commit()

    cur.execute("SELECT COUNT(*) AS c FROM nomenclature_mappings")
    after = cur.fetchone()['c']
    print('\n=== samples ===')
    for s in sample_lines: print(s)
    print(f'\n=== stats ===')
    print(f'attempts:  {total_attempts}')
    print(f'inserted:  {inserted}')
    print(f'skipped:   {skipped}   (duplicates / cross-catalog collisions)')
    print(f'mappings before/after: {before} → {after}')
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
