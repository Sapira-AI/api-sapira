"""
build-snapshots.py — convierte las lecturas EN VIVO de prod (MCP de Supabase) en los snapshots por módulo que consume
scripts/espejo/generate-espejo.py. No se conecta a nada: solo parsea archivos.

Entradas:
  1) raw list_tables   — salida cruda de la tool MCP `list_tables` (schemas ['public'], verbose true), tal como la guarda
                          el harness (JSON {"tables":[...]}).
  2) raw catalog       — salida cruda de la tool MCP `execute_sql` con la consulta de catálogo (ver README de entities/);
                          el harness la guarda como JSON {"result": "...<untrusted-data-…>[{"result":{...}}]</untrusted-data-…>"}.
  3) module-map.json   — tabla → carpeta (scripts/espejo/module-map.json).
  4) existing-entities.json — inventario de entities existentes (no se duplican).
  5) outdir            — scripts/espejo/snapshots
  6) (opcional) existing metadata — salida de extract-existing-metadata.ts para TODAS las tablas con entity.
Salida por módulo: <m>.pgmeta.json, <m>.catalog.json, <m>.existing.json (si hay metadata) — con '/' → '-' en el nombre.

Uso:
  python3 scripts/espejo/build-snapshots.py raw/list-tables.json raw/catalog.json scripts/espejo/module-map.json \
      scripts/espejo/existing-entities.json scripts/espejo/snapshots [scripts/espejo/snapshots/raw/existing-metadata.json]
"""
import json
import os
import re
import sys

RAW_LIST, RAW_CAT, MODMAP, EXISTING, OUT = sys.argv[1:6]
EXISTING_META = sys.argv[6] if len(sys.argv) > 6 else None


def load_tool_output(path):
    txt = open(path, encoding='utf-8').read()
    try:
        obj = json.loads(txt)
    except json.JSONDecodeError:
        obj = None
    if isinstance(obj, dict) and 'tables' in obj and isinstance(obj['tables'], list):
        return obj
    text = obj['result'] if isinstance(obj, dict) and isinstance(obj.get('result'), str) else txt
    # el harness envuelve el resultado en <untrusted-data-X> … </untrusted-data-X>; la misma etiqueta aparece antes
    # dentro de una frase, así que se toma la ÚLTIMA apertura previa al cierre
    close = text.find('</untrusted-data-')
    if close >= 0:
        open_tag = text.rfind('<untrusted-data-', 0, close)
        inner = text[text.find('>', open_tag) + 1:close].strip()
    else:
        inner = text
    rows = json.loads(inner)
    return rows[0]['result'] if isinstance(rows, list) else rows


def balanced_end(s, start):
    """índice del ')' que cierra el '(' en s[start]"""
    depth = 0
    for i in range(start, len(s)):
        if s[i] == '(':
            depth += 1
        elif s[i] == ')':
            depth -= 1
            if depth == 0:
                return i
    return -1


def split_top(s):
    parts, depth, cur = [], 0, ''
    for ch in s:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def ident_cols(s):
    cols = []
    for tok in split_top(s):
        m = re.fullmatch(r'"?([A-Za-z_][A-Za-z0-9_]*)"?', tok)
        if not m:
            return None
        cols.append(m.group(1))
    return cols


def strip_outer_parens(expr):
    expr = expr.strip()
    while expr.startswith('(') and balanced_end(expr, 0) == len(expr) - 1:
        expr = expr[1:-1].strip()
    return expr


def parse_constraint(c):
    d, ty = c['def'], c['type']
    out = {'name': c['name'], 'type': ty}
    if ty == 'p':
        m = re.match(r'PRIMARY KEY \((.*)\)$', d)
        out['cols'] = ident_cols(m.group(1)) if m else None
    elif ty == 'u':
        m = re.match(r'UNIQUE(?: NULLS NOT DISTINCT)? \((.*)\)$', d)
        out['cols'] = ident_cols(m.group(1)) if m else None
    elif ty == 'c':
        out['expr'] = strip_outer_parens(d[len('CHECK'):])
    elif ty == 'f':
        out['ondelete'] = (c.get('ondelete') or 'a').strip() or 'a'
        out['onupdate'] = (c.get('onupdate') or 'a').strip() or 'a'
        out['def'] = d
    else:
        out['def'] = d
    if c.get('deferrable'):
        out['deferrable'] = True
        out['initially_deferred'] = bool(c.get('initially_deferred'))
    return out


def parse_index(i, constraint_names):
    d = i['def']
    name = i['name']
    if name in constraint_names:
        return None  # respalda PK/UNIQUE: no se emite como @Index
    unique = d.startswith('CREATE UNIQUE INDEX')
    m = re.search(r' USING (\w+) \(', d)
    if not m:
        return {'name': name, 'cols': None, 'unique': unique, 'where': None, 'expr': d}
    method = m.group(1)
    start = m.end() - 1
    end = balanced_end(d, start)
    cols_raw = d[start + 1:end]
    rest = d[end + 1:].strip()
    where = None
    if rest.startswith('WHERE'):
        where = strip_outer_parens(rest[len('WHERE'):])
    cols = ident_cols(cols_raw)
    out = {'name': name, 'cols': cols, 'unique': unique, 'where': where}
    if cols is None or method != 'btree':
        out['expr'] = d  # índice con expresión/orden/opclass/método no btree: se documenta, no se declara
        out['cols'] = None
    return out


def parse_trigger(t):
    d = t['def']
    m = re.match(r'CREATE (?:CONSTRAINT )?TRIGGER (\S+) (BEFORE|AFTER|INSTEAD OF) (.*?) ON \S+ (?:FROM \S+ )?(?:(?:NOT DEFERRABLE|DEFERRABLE|INITIALLY \w+) )*FOR EACH (ROW|STATEMENT) (?:WHEN \((.*)\) )?EXECUTE (?:FUNCTION|PROCEDURE) (.*)$', d)
    if not m:
        s = f"{t['name']} · {d}"
    else:
        name, timing, events, each, when, fn = m.groups()
        s = f"{name} · {timing} {events} FOR EACH {each} → {fn}"
        if when:
            s += f" [WHEN {when}]"
    if t.get('enabled') == 'D':
        s += ' (DESHABILITADO)'
    return s


lt = load_tool_output(RAW_LIST)
cat = load_tool_output(RAW_CAT)
modmap = {k: v for k, v in json.load(open(MODMAP)).items() if not k.startswith('_')}
existing = json.load(open(EXISTING))
existing_meta = json.load(open(EXISTING_META)) if EXISTING_META else {}
pg = {t['name'].split('.', 1)[1]: t for t in lt['tables']}
ct = cat['tables']
enums = cat.get('enums') or {}

os.makedirs(OUT, exist_ok=True)
mapped = {t for ts in modmap.values() for t in ts}
print('tablas en vivo:', len(pg), '| en module-map:', len(mapped), '| sin módulo:', sorted(set(pg) - mapped), '| en map pero no en prod:', sorted(mapped - set(pg)))
udts, expr_indexes, no_pk, enum_cols = set(), [], [], []
for mod, tabs in modmap.items():
    pgm, catm, exm = {}, {'_meta': {'source': 'prod hklompkypzqtglprfobu · MCP Supabase list_tables verbose + execute_sql (solo lectura) sobre pg_catalog', 'date': '2026-08-22'}, '_enums': enums}, {}
    for table in tabs:
        if table not in pg:
            continue
        pgm[table] = pg[table]
        c = ct.get(table) or {}
        cons = [parse_constraint(x) for x in (c.get('constraints') or [])]
        cnames = {x['name'] for x in cons}
        idxs = [parse_index(x, cnames) for x in (c.get('indexes') or [])]
        idxs = [x for x in idxs if x]
        cols_extra = {}
        for col in c.get('columns') or []:
            e = {}
            if col.get('char_len'):
                e['length'] = col['char_len']
            if col['udt'] == 'numeric' and col.get('num_prec') is not None:
                e['precision'] = col['num_prec']
                e['scale'] = col.get('num_scale')
            if col.get('identity') == 'YES':
                e['identity'] = True
            if col.get('generated') == 'ALWAYS':
                e['generated'] = col.get('gen_expr')
            if e:
                cols_extra[col['column']] = e
            udts.add(col['udt'])
        for col in pg[table]['columns']:
            if col['data_type'] == 'USER-DEFINED':
                enum_cols.append(f"{table}.{col['name']} ({col['format']})")
        if not any(x['type'] == 'p' for x in cons):
            no_pk.append(table)
        expr_indexes += [f"{table}: {x['name']}" for x in idxs if x.get('expr')]
        catm[table] = {
            'comment': c.get('comment'),
            'rls': c.get('rls'), 'rls_forced': c.get('rls_forced'),
            'columns': cols_extra,
            'constraints': cons,
            'indexes': idxs,
            'triggers': [parse_trigger(x) for x in (c.get('triggers') or [])],
            'policies': [f"{p['name']} ({p['cmd']}, {', '.join(p.get('roles') or [])})" for p in (c.get('policies') or [])],
            'policies_detail': c.get('policies') or [],
        }
        if table in existing_meta:
            exm[table] = existing_meta[table]
    base = os.path.join(OUT, mod.replace('/', '-'))
    json.dump(pgm, open(base + '.pgmeta.json', 'w'), indent=1, ensure_ascii=False)
    json.dump(catm, open(base + '.catalog.json', 'w'), indent=1, ensure_ascii=False)
    if existing_meta:
        json.dump(exm, open(base + '.existing.json', 'w'), indent=1, ensure_ascii=False)
    print(f"{mod:<26} tablas={len(pgm):>3} existentes={sum(1 for t in pgm if t in existing):>2} crear={sum(1 for t in pgm if t not in existing):>2} existing-meta={len(exm)}")
print('\nudts vistos:', sorted(udts))
print('enums definidos:', {k: len(v) for k, v in enums.items()})
print('columnas enum:', enum_cols)
print('tablas sin PK:', no_pk)
print('índices con expresión/orden/método no btree (se documentan, no se declaran):', expr_indexes)
