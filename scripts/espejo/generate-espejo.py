"""
Generador del ESPEJO de entities (rediseño v2, paso 1 · carril B).

Reglas:
  - Fuente única: lecturas EN VIVO de prod (MCP de Supabase), ya convertidas a snapshots por scripts/espejo/build-snapshots.py.
  - Las tablas que YA tienen entity en el repo (scripts/espejo/existing-entities.json) NO se duplican: se documenta en el README
    del módulo dónde está la entity y su diferencia con prod (metadata TypeORM real vs lectura en vivo).
  - Solo se generan espejos para las tablas sin entity, APAGADOS en runtime: `<tabla>.espejo.ts` (no terminan en .entity.ts,
    así el glob `**/*.entity.ts` de database.module.ts no los carga y ningún módulo los registra en forFeature).
  - Una entity PROMOVIDA (`<tabla>.entity.ts`) NO se reescribe: desde su promoción la fuente de verdad de esa tabla es el repo.
    Para ella se siguen emitiendo el snapshot de prod (contra el que la mide su spec), el barrel, el registro y el README, así que
    la deriva se sigue detectando; el archivo lo edita quien cambia la tabla, con su migración.
  - Las FKs apuntan a la entity existente (import @/databases/postgresql/entities/<dominio>/…) o al espejo de su módulo (este u otro, vía
    scripts/espejo/generated-entities.json). Generar todos los módulos en DOS pasadas para resolver FKs entre módulos.

Uso:
  python3 scripts/espejo/generate-espejo.py <modulo> [--registry scripts/espejo/generated-entities.json]
  (lee scripts/espejo/snapshots/<modulo>.{pgmeta,catalog,existing}.json y escribe src/databases/postgresql/entities/<modulo>/)
Salida por módulo: <tabla>.espejo.ts, index.ts, <modulo>.prod-snapshot.ts, <modulo>.entities.spec.ts, README.md.
Globales (se regeneran siempre): entities/espejo.index.ts (todos los espejos) y entities/espejo.existing.ts (todas las entities
existentes, solo para los specs).
"""
import datetime
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SNAP_DIR = os.path.join(ROOT, 'scripts', 'espejo', 'snapshots')
ENTITIES_DIR = os.path.join(ROOT, 'src', 'databases', 'postgresql', 'entities')
EXISTING_PATH = os.path.join(ROOT, 'scripts', 'espejo', 'existing-entities.json')
MODMAP_PATH = os.path.join(ROOT, 'scripts', 'espejo', 'module-map.json')
REGISTRY_PATH = os.path.join(ROOT, 'scripts', 'espejo', 'generated-entities.json')
PROJECT = 'hklompkypzqtglprfobu'


def fecha_del_catalogo():
    """Fecha de la captura que se está usando, no una constante.

    Estaba hardcodeada en '2026-08-22': al refrescar los snapshots desde prod, cada archivo
    generado seguía declarando esa fecha y el README mentía sobre cuándo se midió.
    """
    crudo = os.path.join(ROOT, 'scripts', 'espejo', 'snapshots', 'raw', 'catalog.json')
    if '--date' in sys.argv:
        return sys.argv[sys.argv.index('--date') + 1]
    if os.path.exists(crudo):
        return datetime.date.fromtimestamp(os.path.getmtime(crudo)).isoformat()
    return datetime.date.today().isoformat()


DATE = fecha_del_catalogo()

def cols_fk(v):
    """Columnas de una FK. `fetch-catalog.ts` las emite como lista; si el driver no parsea el
    array de Postgres llegan como el literal `{a,b}`, y recorrerlo como lista produce un
    `@JoinColumn` con una entrada por carácter. Se normaliza acá para tolerar ambas formas."""
    if isinstance(v, str):
        return [c.strip().strip('"') for c in v.strip('{}').split(',') if c.strip()]
    return list(v)


MODULE = sys.argv[1]
if '--registry' in sys.argv:
    REGISTRY_PATH = sys.argv[sys.argv.index('--registry') + 1]
MOD_ID = MODULE.replace('/', '-')
OUTDIR = os.path.join(ENTITIES_DIR, *MODULE.split('/'))
DEPTH = len(MODULE.split('/'))  # carpetas debajo de entities/
UP = '../' * DEPTH  # hasta entities/

MODULE_TITLES = {
    'base-tenancy': '1 · Base / Tenancy', 'fx': '2 · FX y datos económicos', 'clientes': '3 · Clientes',
    'cotizaciones-catalogo': '4 · Cotizaciones y catálogo', 'contratos': '5 · Contratos', 'facturacion': '6 · Facturación',
    'revenue': '7 · Revenue / períodos', 'legacy': '8 · Legacy / onboarding', 'conciliacion': '9 · Conciliación y pagos',
    'integraciones/salesforce': '10 · Integraciones — Salesforce', 'integraciones/odoo': '10 · Integraciones — Odoo',
    'integraciones/stripe': '10 · Integraciones — Stripe', 'integraciones/otras': '10 · Integraciones — otras',
    'automatizaciones-ia': '11 · Automatizaciones, IA, notificaciones y correo', 'suscripciones': '12 · Suscripciones (Stripe)',
    'sii': '13 · Emisión fiscal nativa (SII)',
}
CLASS_OVERRIDES = {'master_data': 'MasterData', 'financial_settings': 'FinancialSettings', 'holding_settings': 'HoldingSettings'}
KEEP_PLURAL = {'data', 'settings', 'stg', 'cache', 'legacy', 'match', 'log', 'status', 'bigquery', 'history', 'monthly'}
TYPES = {
    'uuid': ('uuid', 'string'), 'text': ('text', 'string'), 'varchar': ('varchar', 'string'), 'bpchar': ('char', 'string'),
    'bool': ('boolean', 'boolean'), 'int2': ('smallint', 'number'), 'int4': ('integer', 'number'), 'int8': ('bigint', 'string'),
    'numeric': ('numeric', 'number'), 'float4': ('real', 'number'), 'float8': ('double precision', 'number'),
    'timestamp': ('timestamp without time zone', 'Date'), 'timestamptz': ('timestamp with time zone', 'Date'),
    'date': ('date', 'Date'), 'time': ('time without time zone', 'string'), 'timetz': ('time with time zone', 'string'),
    'interval': ('interval', 'string'), 'jsonb': ('jsonb', 'any'), 'json': ('json', 'any'), 'bytea': ('bytea', 'Buffer'),
    'inet': ('inet', 'string'), 'vector': ('vector', 'string'), 'halfvec': ('halfvec', 'string'),  # pgvector (TypeORM 0.3.28 los acepta)
}
UNSUPPORTED = {}  # tipos que TypeORM no acepte en metadata: {udt: tipo sustituto}; se declara el sustituto y se documenta
ON_ACTION = {'a': None, 'c': 'CASCADE', 'n': 'SET NULL', 'r': 'RESTRICT', 'd': 'SET DEFAULT'}
NORM_TYPE = {
    'timestamp': 'timestamp without time zone', 'timestamptz': 'timestamp with time zone', 'decimal': 'numeric', 'int': 'integer',
    'int4': 'integer', 'int8': 'bigint', 'bool': 'boolean', 'character varying': 'varchar', 'character': 'char', 'float': 'double precision',
}


def load(path, default=None):
    if not os.path.exists(path):
        return default
    return json.load(open(path, encoding='utf-8'))


def singular(word):
    if word in KEEP_PLURAL or word.endswith('us') or word.endswith('ss'):
        return word
    if word.endswith('ies'):
        return word[:-3] + 'y'
    if word.endswith(('ses', 'xes', 'ches', 'shes')):
        return word[:-2]
    if word.endswith('s'):
        return word[:-1]
    return word


def class_name(table):
    if table in CLASS_OVERRIDES:
        return CLASS_OVERRIDES[table]
    parts = table.split('_')
    parts[-1] = singular(parts[-1])
    return ''.join(p.capitalize() for p in parts)


def kebab(cls):
    return re.sub(r'(?<!^)(?=[A-Z])', '-', cls).lower()


def camel(s):
    parts = s.split('_')
    return parts[0] + ''.join(p.capitalize() for p in parts[1:])


def ts_default(dv):
    if dv is None:
        return None
    if dv == 'now()':
        return "() => 'now()'"
    if dv in ('true', 'false'):
        return dv
    if re.fullmatch(r'-?\d+(\.\d+)?', dv):
        return dv
    m = re.fullmatch(r"'(.*)'::[a-z_ ]+(\[\])?", dv, re.S)
    if m:
        return "'" + m.group(1).replace('\\', '\\\\').replace("'", "\\'") + "'"
    return '() => "' + dv.replace('\\', '\\\\').replace('"', '\\"') + '"'


def ts_str(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


def jsdoc_lines(text):
    return [l.rstrip() for l in text.replace('*/', '* /').split('\n')]


def md(s):
    return str(s).replace('|', '\\|').replace('\n', ' ')


def norm_default(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (dict, list)):
        return json.dumps(v, separators=(',', ':')).lower()
    s = str(v).strip()
    s = re.sub(r'::[a-z_ \[\]]+$', '', s)
    return s.strip("'").lower()


ENTIDAD_DECO = re.compile(r"@Entity\(\s*(?:\{(?P<opts>[^)]*?)name:\s*)?'(?P<tabla>[a-z_0-9]+)'")


def existing_en_disco():
    """Inventario de las entities del repo leído del DISCO: tabla → {class, file, import}.

    Antes salía de `existing-entities.json`, escrito a mano el 2026-08-22. Ese acoplamiento se
    pudre solo: cuando se corrió este generador tras borrar y mover entities, 5 de 59 entradas
    apuntaban a archivos inexistentes y `target_ref()` emitía imports rotos en 84 espejos.

    Dos exclusiones, cada una por una razón concreta:
      - Las tablas que están en `generated-entities.json` NO son entities del repo: son espejos,
        y algunos ya promovidos a `.entity.ts`. Si entraran acá el generador dejaría de emitirlos
        y desaparecerían de los barrels y de los prod-snapshot. La resta la hace el llamador.
      - Las entities de un esquema que no es `public` (`auth-user.entity.ts` declara
        `auth.users`) colisionarían por clave con la tabla `public` del mismo nombre.
    """
    encontradas = {}
    src_dir = os.path.join(ROOT, 'src')
    for base, _, archivos in sorted(os.walk(src_dir)):
        for archivo in sorted(archivos):
            if not archivo.endswith('.entity.ts'):
                continue
            ruta = os.path.join(base, archivo)
            contenido = open(ruta, encoding='utf-8').read()
            for m in ENTIDAD_DECO.finditer(contenido):
                opts = m.group('opts') or ''
                if "schema:" in opts and "schema: 'public'" not in opts:
                    continue
                clase = re.search(r'export class (\w+)', contenido[m.end():])
                if not clase:
                    continue
                encontradas[m.group('tabla')] = {
                    'class': clase.group(1),
                    'file': os.path.relpath(ruta, ROOT).replace(os.sep, '/'),
                    'import': '@/' + os.path.relpath(ruta, src_dir).replace(os.sep, '/')[: -len('.ts')],
                }
    return encontradas


pgmeta = load(os.path.join(SNAP_DIR, MOD_ID + '.pgmeta.json'))
catalog = load(os.path.join(SNAP_DIR, MOD_ID + '.catalog.json'), {})
existing_meta = load(os.path.join(SNAP_DIR, MOD_ID + '.existing.json'), {})
registry = load(REGISTRY_PATH, {})
existing = {tabla: e for tabla, e in existing_en_disco().items() if tabla not in registry}
modmap = {k: v for k, v in load(MODMAP_PATH).items() if not k.startswith('_')}
enums = catalog.get('_enums') or {}
catalog = {k: v for k, v in catalog.items() if not k.startswith('_')}
if pgmeta is None:
    sys.exit(f'no existe el snapshot {MOD_ID}.pgmeta.json (correr build-snapshots.py)')

tables = {name.split('.', 1)[1]: t for name, t in ((t['name'], t) for t in pgmeta.values())}
order = [t for t in modmap.get(MODULE, []) if t in tables] or list(tables.keys())
CLASS = {t: class_name(t) for t in order}


def live_type(col):
    fmt = col['format']
    array = fmt.startswith('_')
    if array:
        fmt = fmt[1:]
    if col['data_type'] == 'USER-DEFINED' and fmt in enums:
        return 'enum', 'string', array, fmt
    if fmt in UNSUPPORTED:
        return UNSUPPORTED[fmt], 'any', array, fmt  # se documenta como tipo no soportado
    pg, ts = TYPES.get(fmt, (fmt, 'any'))
    return pg, ts + ('[]' if array else ''), array, None


def sufijo_espejo(clase, outdir=None):
    """`.entity` si el espejo ya fue promovido (existe el archivo), `.espejo` si sigue inerte.

    Sin esto el generador emitiría `<tabla>.espejo.ts` para una tabla ya promovida y quedarían dos
    clases mapeando la misma tabla: la promovida que carga runtime y el espejo que exporta el
    barrel. Pasó con `permissions`.

    Se sigue usando después de retirar la reescritura (2026-09-22), porque el barrel y los imports
    de FK tienen que apuntar al `.entity` promovido.
    """
    base = kebab(clase)
    destino = outdir if outdir is not None else OUTDIR
    return '.entity' if os.path.exists(os.path.join(destino, base + '.entity.ts')) else '.espejo'


def target_ref(target_table):
    """(clase, import, grupo) de la tabla destino de una FK: entity existente, espejo de este módulo u espejo de otro módulo."""
    if target_table in existing:
        return existing[target_table]['class'], existing[target_table]['import'], 'internal'
    if target_table in CLASS:
        return CLASS[target_table], './' + kebab(CLASS[target_table]) + sufijo_espejo(CLASS[target_table]), 'sibling'
    if target_table in registry:
        r = registry[target_table]
        target_dir = os.path.join(ENTITIES_DIR, *r['module'].split('/'))
        rel = os.path.relpath(target_dir, OUTDIR).replace(os.sep, '/')
        return r['class'], f"{rel}/{r['file'][:-3]}", 'parent'
    return None, None, None


os.makedirs(OUTDIR, exist_ok=True)
created_rows, existing_rows, column_sections, snapshot, generated = [], [], [], {}, []
spec_needs = {}  # clase → import (entities existentes u otros módulos que los espejos referencian)
for table in order:
    t = tables[table]
    c_tab = catalog.get(table) or {}
    cols = t['columns']
    pk = t['primary_keys']
    fks = [f for f in t.get('foreign_key_constraints', []) if f['source_table'] == t['name']]
    incoming = sorted({f['source_table'].split('.', 1)[1] for f in t.get('foreign_key_constraints', []) if f['target_table'] == t['name'] and f['source_table'] != t['name']})
    cons = c_tab.get('constraints', [])
    pk_name = next((c['name'] for c in cons if c['type'] == 'p'), None)
    uniques = [c for c in cons if c['type'] == 'u' and c.get('cols')]
    checks = [c for c in cons if c['type'] == 'c']
    other_cons = [c for c in cons if c['type'] not in ('p', 'u', 'c', 'f')]
    fk_rules = {c['name']: c for c in cons if c['type'] == 'f'}
    indexes = [i for i in c_tab.get('indexes', []) if i.get('cols')]
    expr_indexes = [i for i in c_tab.get('indexes', []) if not i.get('cols')]
    col_extra = c_tab.get('columns', {})
    rls = t.get('rls_enabled')

    # ---------- tabla con entity existente: NO se duplica; se documenta la diferencia con prod ----------
    if table in existing:
        ex = existing[table]
        meta = existing_meta.get(table)
        missing_cols, extra_cols, diffs, missing_cons = [], [], [], []
        if meta:
            ecols = meta['columns']
            for c in cols:
                pg, _, array, _ = live_type(c)
                live_len = (col_extra.get(c['name']) or {}).get('length')
                if c['name'] not in ecols:
                    missing_cols.append(f"`{c['name']}` {pg}{'[]' if array else ''}{'' if 'nullable' in c.get('options', []) else ' NOT NULL'}")
                    continue
                e = ecols[c['name']]
                et = NORM_TYPE.get(e['type'], e['type'])
                if pg != 'enum' and (et != pg or bool(e.get('array')) != array):
                    diffs.append(f"`{c['name']}`: tipo `{e['type']}{'[]' if e.get('array') else ''}` vs DB `{pg}{'[]' if array else ''}`")
                live_null = 'nullable' in c.get('options', [])
                if bool(e['nullable']) != live_null and not e.get('primary'):
                    diffs.append(f"`{c['name']}`: {'nullable' if e['nullable'] else 'NOT NULL'} en la entity vs {'nullable' if live_null else 'NOT NULL'} en DB")
                ed, ld = norm_default(e.get('default')), norm_default(c.get('default_value'))
                if e.get('generated') == 'uuid' and ld == 'gen_random_uuid()':
                    ed = ld
                if ed != ld:
                    diffs.append(f"`{c['name']}`: default `{e.get('default')}` vs DB `{c.get('default_value')}`")
                if live_len and str(e.get('length') or '') != str(live_len):
                    diffs.append(f"`{c['name']}`: length `{e.get('length')}` vs DB `{live_len}`")
            for name in ecols:
                if name not in {c['name'] for c in cols}:
                    extra_cols.append(f"`{name}`")
            e_unique_sets = {tuple(sorted(v)) for v in meta['uniques'].values()} | {tuple(sorted(i['columns'])) for i in meta['indices'].values() if i['unique']}
            e_index_sets = {tuple(sorted(i['columns'])) for i in meta['indices'].values()}
            e_fk_cols = {tuple(sorted(v['columns'])) for v in meta['foreignKeys'].values()}
            if pk_name:
                missing_cons.append(f"nombre de PK `{pk_name}`")
            for u in uniques:
                if tuple(sorted(u['cols'])) not in e_unique_sets:
                    missing_cons.append(f"UNIQUE `{u['name']}` ({', '.join(u['cols'])})")
            e_check_exprs = {re.sub(r'\s+', ' ', ch['expression']).strip().lower() for ch in meta['checks']}
            for ch in checks:
                if re.sub(r'\s+', ' ', ch['expr']).strip().lower() not in e_check_exprs:
                    missing_cons.append(f"CHECK `{ch['name']}`")
            for f in fks:
                od = ON_ACTION.get(fk_rules.get(f['name'], {}).get('ondelete', 'a'))
                if tuple(sorted(cols_fk(f['source_columns']))) not in e_fk_cols:
                    missing_cons.append(f"FK `{f['name']}` → {f['target_table'].split('.', 1)[1]}" + (f' ON DELETE {od}' if od else ''))
            for i in indexes:
                if tuple(sorted(i['cols'])) not in e_index_sets:
                    missing_cons.append(f"índice `{i['name']}`" + (' (UNIQUE' + (', parcial)' if i.get('where') else ')') if i.get('unique') else (' (parcial)' if i.get('where') else '')))
            for i in expr_indexes:
                missing_cons.append(f"índice con expresión `{i['name']}`")
        status = '✅ igual a prod' if meta and not (missing_cols or extra_cols or diffs or missing_cons) else ('⚠️ difiere de prod' if meta else '❔ sin metadata')
        existing_rows.append(f"| `{table}` ({t['rows']}) | `{ex['file']}` · `{ex['class']}` | {status} | {'<br>'.join(missing_cols) or '—'} | {'<br>'.join(extra_cols) or '—'} | {'<br>'.join(diffs) or '—'} | {'<br>'.join(missing_cons) or '—'} |")
        continue

    # ---------- tabla sin entity: espejo apagado ----------
    cls = CLASS[table]
    generated.append(table)
    fname = kebab(cls) + sufijo_espejo(cls) + '.ts'
    promovido = fname.endswith('.entity.ts')
    single_unique_cols = {c['cols'][0] for c in uniques if len(c['cols']) == 1}
    decos = {'Entity'}
    imports = {'internal': {}, 'parent': {}, 'sibling': {}}
    body, class_decos, notes = [], [], []
    for u in uniques:
        decos.add('Unique')
        class_decos.append(f"@Unique('{u['name']}', [{', '.join(repr(c) for c in u['cols'])}])")
    if checks:
        for c in checks:
            decos.add('Check')
            class_decos.append(f"@Check('{c['name']}', {ts_str(c['expr'])})")
    else:
        for c in cols:
            if c.get('check'):
                decos.add('Check')
                class_decos.append('@Check(' + ts_str(c['check']) + ')')
    for i in indexes:
        decos.add('Index')
        opts = []
        if i.get('unique'):
            opts.append('unique: true')
        if i.get('where'):
            opts.append("where: " + ts_str(i['where']))
        class_decos.append(f"@Index('{i['name']}', [{', '.join(repr(c) for c in i['cols'])}]" + (', { ' + ', '.join(opts) + ' }' if opts else '') + ')')
    for i in expr_indexes:
        notes.append(f"Índice no declarado (expresión/orden/método): {i['expr']}")
    for c in other_cons:
        notes.append(f"Constraint no declarado (tipo {c['type']}): {c['name']} {c.get('def', '')}")

    colnames = {c['name'] for c in cols}
    used_props = set()
    snap_cols, col_rows = {}, []
    for c in cols:
        name = c['name']
        opts_list = c.get('options', [])
        nullable = 'nullable' in opts_list
        unique = 'unique' in opts_list
        dv = c.get('default_value')
        pgtype, tstype, array, enum_name = live_type(c)
        fmt = c['format'][1:] if c['format'].startswith('_') else c['format']
        extra = col_extra.get(name, {})
        lines = []
        comment_parts = []
        if c.get('comment'):
            comment_parts.append(c['comment'])
        if pgtype in UNSUPPORTED.values() and fmt in UNSUPPORTED:
            comment_parts.append(f"Tipo real en DB: {fmt} (extensión; TypeORM 0.3 no lo acepta en metadata, se declara como {pgtype} — revisar en paso 3)")
            notes.append(f"Columna {name}: tipo real {fmt} (pgvector) declarado como {pgtype}")
        if extra.get('identity'):
            comment_parts.append('Columna IDENTITY en DB')
        if extra.get('generated'):
            comment_parts.append(f"Columna generada en DB: {extra['generated']}")
        # El comentario de prod va TAMBIÉN como opción `comment` del decorador, no solo al JSDoc:
        # TypeORM compara comentarios al calcular la deriva, y si la entity no lo declara emite
        # `COMMENT ON COLUMN ... IS NULL`, que borraría el comentario real de producción.
        comment_opt = [f"comment: {ts_str(c['comment'])}"] if c.get('comment') else []
        if comment_parts:
            cl = jsdoc_lines('\n'.join(comment_parts))
            lines.append('\t/** ' + cl[0] + ' */' if len(cl) == 1 else '\t/**\n' + '\n'.join('\t * ' + l for l in cl) + '\n\t */')
        is_pk = name in pk
        if pgtype == 'enum':
            type_opts = ["type: 'enum'", 'enum: [' + ', '.join(repr(v) for v in enums[enum_name]) + ']', f"enumName: '{enum_name}'"]
            pg_label = f"{enum_name} (enum: {', '.join(enums[enum_name])})"
        else:
            type_opts = [f"type: '{pgtype}'"]
            pg_label = pgtype
        if extra.get('length'):
            type_opts.append(f"length: {extra['length']}")
            pg_label += f"({extra['length']})"
        if extra.get('precision') is not None:
            type_opts.append(f"precision: {extra['precision']}")
            pg_label += f"({extra['precision']},{extra.get('scale') or 0})"
            if extra.get('scale') is not None:
                type_opts.append(f"scale: {extra['scale']}")
        if array:
            pg_label += '[]'
        type_opts += comment_opt
        pk_opt = [f"primaryKeyConstraintName: '{pk_name}'"] if pk_name else []
        if is_pk and len(pk) == 1 and fmt == 'uuid' and dv == 'gen_random_uuid()':
            decos.add('PrimaryGeneratedColumn')
            gen_opt = pk_opt + comment_opt
            lines.append("\t@PrimaryGeneratedColumn('uuid'" + (', { ' + ', '.join(gen_opt) + ' }' if gen_opt else '') + ')')
        elif is_pk and len(pk) == 1 and (extra.get('identity') or (dv or '').startswith('nextval(')):
            decos.add('PrimaryGeneratedColumn')
            gen_opt = pk_opt + comment_opt
            lines.append("\t@PrimaryGeneratedColumn('identity'" + (', { ' + ', '.join(gen_opt) + ' }' if gen_opt else '') + ')' if extra.get('identity') else "\t@PrimaryGeneratedColumn('increment'" + (', { ' + ', '.join(gen_opt) + ' }' if gen_opt else '') + ')')
        elif is_pk:
            decos.add('PrimaryColumn')
            o = type_opts + pk_opt
            if dv and dv != 'gen_random_uuid()':
                o.append('default: ' + ts_default(dv))
            lines.append('\t@PrimaryColumn({ ' + ', '.join(o) + ' })')
        else:
            o = list(type_opts)
            if array:
                o.append('array: true')
            o.append('nullable: ' + ('true' if nullable else 'false'))
            if dv is not None:
                o.append('default: ' + ts_default(dv))
            if unique and name not in single_unique_cols:
                o.append('unique: true')
            if name == 'created_at' and dv == 'now()':
                decos.add('CreateDateColumn')
                lines.append('\t@CreateDateColumn({ ' + ', '.join(o) + ' })')
            elif name == 'updated_at' and dv == 'now()':
                decos.add('UpdateDateColumn')
                lines.append('\t@UpdateDateColumn({ ' + ', '.join(o) + ' })')
            else:
                decos.add('Column')
                lines.append('\t@Column({ ' + ', '.join(o) + ' })')
        q = '?' if (nullable and not is_pk) else ''
        lines.append(f'\t{name}{q}: {tstype};')
        body.append('\n'.join(lines))
        snap_cols[name] = nullable
        col_rows.append(f"| `{name}`{' 🔑' if is_pk else ''} | {md(pg_label)} | {'sí' if nullable else 'no'} | {md(dv) if dv is not None else '—'} | {md(c['comment']) if c.get('comment') else ''} |")

    snap_fks = {}
    for f in fks:
        target = f['target_table'].split('.', 1)[1]
        rule = fk_rules.get(f['name'], {})
        on_delete = ON_ACTION.get(rule.get('ondelete', 'a'))
        on_update = ON_ACTION.get(rule.get('onupdate', 'a'))
        snap_fks[f['name']] = {'table': target, 'onDelete': on_delete or 'NO ACTION'}
        tcls, timp, group = target_ref(target)
        if not tcls:
            body.append(f"\t// FK {f['name']}: ({', '.join(cols_fk(f['source_columns']))}) → {target}({', '.join(cols_fk(f['target_columns']))})" + (f' ON DELETE {on_delete}' if on_delete else '') + ' — la tabla destino aún no tiene entity ni espejo')
            notes.append(f"FK {f['name']} → {target} sin relación declarada (destino sin entity ni espejo todavía)")
            continue
        decos.update({'ManyToOne', 'JoinColumn'})
        if target != table:
            imports[group][tcls] = timp
            if group != 'sibling':
                spec_needs[tcls] = timp
        src, ref = cols_fk(f['source_columns']), cols_fk(f['target_columns'])
        prop = camel(re.sub(r'_id$', '', src[0])) if len(src) == 1 else camel(re.sub(r'_id$', '', f['name']))
        if prop in colnames or prop in ('constructor',):
            prop += 'Ref'
        if prop in used_props:  # FKs duplicadas sobre la misma columna (rareza real de prod): nombre único por constraint
            n = 2
            while f'{prop}{n}' in used_props:
                n += 1
            notes.append(f"FK duplicada sobre ({', '.join(src)}): {f['name']} (relación {prop}{n})")
            prop = f'{prop}{n}'
        used_props.add(prop)
        rel_opts = []
        if on_delete:
            rel_opts.append(f"onDelete: '{on_delete}'")
        if on_update:
            rel_opts.append(f"onUpdate: '{on_update}'")
        rel = f'@ManyToOne(() => {tcls}' + (', { ' + ', '.join(rel_opts) + ' }' if rel_opts else '') + ')'
        if len(src) == 1:
            jc = f"@JoinColumn({{ name: '{src[0]}', referencedColumnName: '{ref[0]}', foreignKeyConstraintName: '{f['name']}' }})"
        else:
            jc = '@JoinColumn([' + ', '.join(f"{{ name: '{s}', referencedColumnName: '{r}', foreignKeyConstraintName: '{f['name']}' }}" for s, r in zip(src, ref)) + '])'
        note = {'internal': ' // entity existente (no se duplica)', 'parent': ' // de otro módulo', 'sibling': ''}[group]
        body.append(f'\t{rel}\n\t{jc}\n\t{prop}?: {tcls};{note}')

    filas = f"{t['rows']} filas" if t.get('rows', -1) >= 0 else 'filas desconocidas (tabla sin ANALYZE)'
    origen = f"`public.{table}` — generado desde prod en vivo (`{PROJECT}`, MCP Supabase, {DATE}). {filas} · RLS {'on' if rls else 'OFF'}{' (forzado)' if c_tab.get('rls_forced') else ''}."
    if promovido:
        # Sin esta rama, los 74 espejos promovidos decían "APAGADO en runtime … termina en `.espejo.ts`"
        # en su propia cabecera: falso, y es lo primero que lee quien abre el archivo (o un agente).
        header = [f"Entity de {origen}"]
        header.append('PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.')
    else:
        header = [f"Espejo de {origen}"]
        header.append('APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.')
    comment = t.get('comment') or c_tab.get('comment')
    if comment:
        header += jsdoc_lines(comment)
    if incoming:
        header.append(f"Referenciada por FK desde {len(incoming)} tabla(s): {', '.join(incoming)}.")
    if c_tab:
        header.append('Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).')
        header.append('Triggers: ' + ('; '.join(c_tab.get('triggers') or []) if c_tab.get('triggers') else 'ninguno') + '.')
        pols = c_tab.get('policies') or []
        header.append(f"Policies ({len(pols)}): " + ('; '.join(pols) if pols else ('ninguna (RLS on sin policies → solo service role)' if rls else 'ninguna (RLS OFF)')) + '.')
        for n in notes:
            header.append(n)
    else:
        header.append('⏳ Pendiente de completar en vivo (requiere `execute_sql` solo lectura): índices, uniques compuestos, nombres de PK/CHECK, reglas ON DELETE/UPDATE, longitudes varchar/precisión numeric, triggers y policies.')
    out = 'import { ' + ', '.join(sorted(decos, key=str.lower)) + " } from 'typeorm';\n"
    for group in ('internal', 'parent', 'sibling'):
        if imports[group]:
            # Ordenados por RUTA: es el criterio de `import/order` con alphabetize en .eslintrc.js.
            # Ordenarlos por nombre de clase hacía que `yarn lint --fix` y este generador se
            # pisaran en bucle sobre los mismos archivos.
            orden = sorted(imports[group], key=lambda k: imports[group][k].lower())
            out += '\n' + '\n'.join(f"import {{ {k} }} from '{imports[group][k]}';" for k in orden) + '\n'
    out += '\n/**\n' + '\n'.join(' * ' + h for h in jsdoc_lines('\n'.join(header))) + '\n */\n'
    tab_comment = t.get('comment') or c_tab.get('comment')
    entity_deco = f"@Entity({{ name: '{table}', comment: {ts_str(tab_comment)} }})" if tab_comment else f"@Entity('{table}')"
    out += '\n'.join([entity_deco] + class_decos) + '\nexport class ' + cls + ' {\n' + '\n\n'.join(body) + '\n}\n'
    # Una entity PROMOVIDA no se reescribe: desde su promoción la fuente de verdad de esa tabla es
    # el repo, no prod. El generador sigue emitiendo todo lo demás para ella —el snapshot contra el
    # que la mide su spec, el barrel, el README y el registro— así que sigue vigilada, pero el
    # archivo lo edita quien cambia la tabla (entity → migración → aplicar).
    if not promovido:
        open(os.path.join(OUTDIR, fname), 'w', encoding='utf-8').write(out)

    snapshot[table] = {
        'columns': snap_cols, 'primary': pk, 'foreignKeys': snap_fks,
        'uniques': {u['name']: u['cols'] for u in uniques},
        'checks': sorted(c['name'] for c in checks),
        'indexes': {i['name']: {'columns': i['cols'], 'unique': bool(i.get('unique')), 'where': i.get('where')} for i in indexes},
    }
    fk_parts = []
    for f in fks:
        od = ON_ACTION.get(fk_rules.get(f['name'], {}).get('ondelete', 'a'))
        fk_parts.append(f"`{f['name']}` → {f['target_table'].split('.', 1)[1]}" + (f' ({od})' if od else ''))
    idx_txt = ', '.join(f"`{i['name']}`" + (' (UNIQUE' + (', parcial)' if i.get('where') else ')') if i.get('unique') else (' (parcial)' if i.get('where') else '')) for i in indexes)
    if expr_indexes:
        idx_txt += (', ' if idx_txt else '') + ', '.join(f"`{i['name']}` (expresión, no declarado)" for i in expr_indexes)
    created_rows.append(f"| `{table}` ({t['rows']}, RLS {'on' if rls else 'OFF'}) | `{fname}` · `{cls}` | {len(cols)} | `{pk_name or '?'}` ({', '.join(pk)}) | {', '.join(f'`{u[chr(110)+chr(97)+chr(109)+chr(101)]}`' for u in uniques) or '—'} | {', '.join(f'`{c[chr(110)+chr(97)+chr(109)+chr(101)]}`' for c in checks) or '—'} | {'<br>'.join(fk_parts) or '—'} | {idx_txt or '—'} | {'<br>'.join(c_tab.get('triggers') or []) or '—'} | {len(c_tab.get('policies') or []) if c_tab else '⏳'} |")
    column_sections.append(f"<details><summary><code>{table}</code> → <code>{fname}</code> · {len(cols)} columnas</summary>\n\n| Columna | Tipo Postgres | Nulo | Default | Comentario |\n|---|---|---|---|---|\n" + '\n'.join(col_rows) + '\n\n</details>')
    registry[table] = {'class': cls, 'module': MODULE, 'file': fname}

# ---------- barrel del módulo, snapshot y spec ----------
n_promovidos = sum(1 for t in generated if sufijo_espejo(CLASS[t]) == '.entity')
barrel = (
    f'/**\n * Espejo del módulo `{MODULE}`: {len(generated)} tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.\n'
    f' * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): {n_promovidos}. Apagadas (`*.espejo.ts`, fuera del glob): {len(generated) - n_promovidos}.\n'
    ' * Las tablas que ya tenían entity no se duplican: ver README.md.\n */\n'
)
barrel += ('\n'.join(f"export {{ {CLASS[t]} }} from './{kebab(CLASS[t])}{sufijo_espejo(CLASS[t])}';" for t in sorted(generated, key=lambda x: kebab(CLASS[x]))) if generated else 'export {};') + '\n'
open(os.path.join(OUTDIR, 'index.ts'), 'w', encoding='utf-8').write(barrel)

const_name = MOD_ID.upper().replace('-', '_') + '_PROD_SNAPSHOT'
for stale in (f'{MOD_ID}.prod-snapshot.ts', f'{MOD_ID}.entities.spec.ts'):
    if not generated and os.path.exists(os.path.join(OUTDIR, stale)):
        os.remove(os.path.join(OUTDIR, stale))
if generated:
    snap_lines = ['/**', f' * Snapshot de prod (`{PROJECT}`, schema public) tomado el {DATE} vía MCP de Supabase (`list_tables verbose` + `execute_sql` de solo lectura sobre pg_catalog).',
                  ' * Solo las tablas espejadas (sin entity previa). Generado por scripts/espejo/generate-espejo.py — el spec compara la metadata TypeORM contra él sin conectarse.', ' */',
                  'export interface ProdTableSnapshot {', '\tcolumns: Record<string, boolean>;', '\tprimary: string[];', '\tforeignKeys: Record<string, { table: string; onDelete: string }>;',
                  '\tuniques: Record<string, string[]>;', '\tchecks: string[];', '\tindexes: Record<string, { columns: string[]; unique: boolean; where: string | null }>;', '}', '',
                  f'export const {const_name}: Record<string, ProdTableSnapshot> = ' + json.dumps(snapshot, ensure_ascii=False, indent='\t') + ';']
    open(os.path.join(OUTDIR, f'{MOD_ID}.prod-snapshot.ts'), 'w', encoding='utf-8').write('\n'.join(snap_lines) + '\n')
    spec = f"""import * as fs from 'fs';
import * as path from 'path';

import {{ DataSource, EntityMetadata }} from 'typeorm';

import * as espejoExistentes from '{UP}espejo.existing';
import * as espejoTodos from '{UP}espejo.index';

import {{ {const_name} }} from './{MOD_ID}.prod-snapshot';

import * as modulo from './index';

/**
 * Verifica que los espejos del módulo `{MODULE}` coinciden con el snapshot de prod (columnas + nullabilidad, PK,
 * FKs con ON DELETE, UNIQUE, CHECK e índices) y que no duplican tablas que ya tienen entity en el repo.
 * Construye la metadata en memoria con TODOS los espejos + todas las entities existentes (destinos de FK): NO abre conexión.
 *
 * ⚠️ SI ESTE SPEC FALLA, el repo y prod difieren. Son dos casos distintos:
 *   1. Cambiaste una entity y todavía no aplicaste su migración a prod → aplicala (GUIA → Sincronizar
 *      cambios) y DESPUÉS refrescá el snapshot con `yarn schema:snapshot`.
 *   2. Nadie tocó el repo → prod cambió por fuera del proceso: hay que revisar qué pasó antes de
 *      refrescar nada.
 * El snapshot es una foto de prod a propósito: sirve de detector de deriva. No lo edites a mano.
 */
describe('Espejo {MODULE} (TypeORM ↔ prod public)', () => {{
	const mirrorEntities = Object.values(modulo);
	const dataSource = new DataSource({{ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] }});
	const existingEntities: Record<string, {{ class: string; file: string }}> = JSON.parse(
		fs.readFileSync(path.join(__dirname, {', '.join(["'..'"] * (DEPTH + 4))}, 'scripts', 'espejo', 'existing-entities.json'), 'utf8')
	);
	let mirrorMetadatas: EntityMetadata[] = [];

	beforeAll(async () => {{
		await (dataSource as unknown as {{ buildMetadatas: () => Promise<void> }}).buildMetadatas();
		const targets = new Set<unknown>(mirrorEntities);
		mirrorMetadatas = dataSource.entityMetadatas.filter((metadata) => targets.has(metadata.target));
	}});

	it('construye la metadata sin conectarse ni sincronizar esquema (guard rojo)', () => {{
		expect(dataSource.isInitialized).toBe(false);
		expect(dataSource.options.synchronize).toBeFalsy();
		expect(mirrorMetadatas.length).toBeGreaterThan(0);
	}});

	it('mapea exactamente las tablas del snapshot (las que no tenían entity en el repo)', () => {{
		expect(mirrorMetadatas.map((m) => m.tableName).sort()).toEqual(Object.keys({const_name}).sort());
	}});

	it('no duplica ninguna tabla que ya tiene entity existente en el repo', () => {{
		expect(mirrorMetadatas.map((m) => m.tableName).filter((table) => table in existingEntities)).toEqual([]);
	}});

	describe.each(Object.entries({const_name}))('%s', (table, expected) => {{
		const metadata = () => mirrorMetadatas.find((m) => m.tableName === table);

		it('tiene las mismas columnas y nullabilidad que prod', () => {{
			expect(Object.fromEntries(metadata().columns.map((column) => [column.databaseName, column.isNullable]))).toEqual(expected.columns);
		}});

		it('tiene la misma clave primaria que prod', () => {{
			expect(
				metadata()
					.primaryColumns.map((column) => column.databaseName)
					.sort()
			).toEqual([...expected.primary].sort());
		}});

		it('tiene las mismas FKs (nombre → tabla, ON DELETE) que prod', () => {{
			expect(
				Object.fromEntries(metadata().foreignKeys.map((fk) => [fk.name, {{ table: fk.referencedEntityMetadata.tableName, onDelete: fk.onDelete }}]))
			).toEqual(expected.foreignKeys);
		}});

		it('tiene los mismos UNIQUE (nombre → columnas) que prod', () => {{
			expect(Object.fromEntries(metadata().uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)]))).toEqual(
				expected.uniques
			);
		}});

		it('tiene los mismos CHECK (nombres) que prod', () => {{
			expect(
				metadata()
					.checks.map((check) => check.name)
					.sort()
			).toEqual([...expected.checks].sort());
		}});

		it('tiene los mismos índices declarables (nombre → columnas, unique, where) que prod', () => {{
			expect(
				Object.fromEntries(
					metadata()
						// `@Index('x', {{ synchronize: false }})` no declara un índice: avisa que existe y que
						// TypeORM no lo toque (los de `special-index/`). No tiene columnas y no va contra el snapshot.
						.indices.filter((index) => index.synchronize !== false)
						.map((index) => [
							index.name,
							{{ columns: index.columns.map((column) => column.databaseName), unique: index.isUnique, where: index.where ?? null }},
						])
				)
			).toEqual(expected.indexes);
		}});
	}});
}});
"""
    open(os.path.join(OUTDIR, f'{MOD_ID}.entities.spec.ts'), 'w', encoding='utf-8').write(spec)

# ---------- README del módulo ----------
title = MODULE_TITLES.get(MODULE, MODULE)
n_exist, n_new = len(existing_rows), len(generated)
readme = [f"# Módulo {title} — {len(order)} tablas de prod ({DATE})", '',
          f"> Convención y reglas: `{UP}README.md`. Rarezas verificadas: `{UP}NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).",
          f"> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `{PROJECT}` vía MCP de Supabase el {DATE} — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/{MOD_ID}.{{pgmeta,catalog}}.json`); metadata real de las entities existentes en `{MOD_ID}.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.",
          '']
readme += [f"## A · Tablas que YA tenían entity en el repo ({n_exist}) — no se tocaron ni se duplicaron", '']
if existing_rows:
    readme += ['Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.', '',
               '| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |', '|---|---|---|---|---|---|---|'] + existing_rows + ['']
else:
    readme += ['Ninguna: todas las tablas de este módulo carecían de entity.', '']
n_prom = sum(1 for t in generated if sufijo_espejo(CLASS[t]) == '.entity')
if n_prom == n_new:
    estado_b = ('**Estado: todas promovidas.** Cada archivo termina en `.entity.ts`, así que `database.module.ts` las carga por el glob '
                '`entities: [__dirname + \'/../../**/*.entity{.ts,.js}\']` y quedan disponibles para `TypeOrmModule.forFeature([...])` en el módulo que las use. '
                'Cada promoción está registrada a mano en `promotedMirrorEntities` de `database.module.spec.ts`. **Desde el 2026-09-22 el generador ya NO las '
                'reescribe**: la entity es la fuente de verdad de su tabla y se edita a mano (entity → `migration:generate` → revisar → `migration:run`). '
                'Lo que el generador sigue emitiendo para ellas es el snapshot contra el que las mide su spec, el barrel y este README: si el spec queda en rojo, '
                'el repo y prod difieren, y el snapshot se refresca con `yarn schema:snapshot` DESPUÉS de aplicar el cambio a prod.')
else:
    estado_b = (f'**Estado: {n_prom} promovidas, {n_new - n_prom} apagadas.** Un espejo apagado termina en `.espejo.ts`: `database.module.ts` carga entities con '
                '`entities: [__dirname + \'/../../**/*.entity{.ts,.js}\']`, así que no lo ve, y ningún módulo lo incluye en `TypeOrmModule.forFeature([...])`. '
                'Para promoverlo: renombrar a `.entity.ts`, regenerar y registrarlo en `promotedMirrorEntities` de `database.module.spec.ts` '
                '(procedimiento en `src/databases/postgresql/README.md` → Promover un espejo).')
readme += [f"## B · Tablas SIN entity previa → espejos generados ({n_new}): {n_prom} promovidas, {n_new - n_prom} apagadas", '']
if created_rows:
    readme += ['| Tabla (filas, RLS) | Archivo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |', '|---|---|---|---|---|---|---|---|---|---|'] + created_rows + ['',
               'Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/' + MOD_ID + '.catalog.json` (`policies_detail`) para el paso 4.', '',
               estado_b, '',
               f"## C · Columnas exactas de cada espejo ({n_new} tablas)", ''] + column_sections + ['',
               '## Verificación (sin conexión a la DB)', '',
               f"- `{MOD_ID}.entities.spec.ts`: metadata TypeORM en memoria vs `{MOD_ID}.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.",
               f"- `{UP}../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, y un espejo solo se carga en runtime si su promoción figura en `promotedMirrorEntities`.", '']
else:
    readme += ['Ninguna: todas las tablas de este módulo ya tienen entity en el repo; este módulo solo documenta el diff (sección A). No hay espejos, snapshot ni spec.', '']
open(os.path.join(OUTDIR, 'README.md'), 'w', encoding='utf-8').write('\n'.join(readme))

# ---------- registro y barrels globales ----------
json.dump(dict(sorted(registry.items())), open(REGISTRY_PATH, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
mods = sorted({r['module'] for r in registry.values()})
gi = ['/**', ' * Barrel de TODOS los espejos (solo para los specs; ningún módulo de la app lo importa). Generado por scripts/espejo/generate-espejo.py.', ' */']
gi += [f"export * from './{m}';" for m in mods]
open(os.path.join(ENTITIES_DIR, 'espejo.index.ts'), 'w', encoding='utf-8').write('\n'.join(gi) + '\n')
# El barrel se arma desde los archivos que existen HOY en disco, no desde existing-entities.json:
# ese inventario es del 2026-08-22 y no sabe de las entities borradas después (`integration_logs`,
# las 4 `integration_salesforce_*`) ni de las agregadas (`auth-user`, `sapira-quantity-import`).
# Armarlo desde el JSON resucitaba las borradas y perdía las nuevas, y los 14 specs del espejo
# fallaban con "Entity metadata for ... was not found".
def entities_en_disco():
    encontradas = {}
    src_dir = os.path.join(ROOT, 'src')
    for base, _, archivos in os.walk(src_dir):
        for archivo in archivos:
            if not archivo.endswith('.entity.ts'):
                continue
            ruta = os.path.join(base, archivo)
            contenido = open(ruta, encoding='utf-8').read()
            if '@Entity(' not in contenido:
                continue
            imp = '@/' + os.path.relpath(ruta, src_dir).replace(os.sep, '/')[: -len('.ts')]
            for clase in re.findall(r'export class (\w+)', contenido):
                encontradas.setdefault(imp, []).append(clase)
    return encontradas


by_import = entities_en_disco()
ge = ['/**', ' * Todas las entities EXISTENTES del repo (las que producción carga), reexportadas SOLO para que los specs del espejo', ' * construyan la metadata con los destinos de FK. Ningún módulo de la app importa este archivo. Generado por scripts/espejo/generate-espejo.py.', ' */']
ge += [f"export {{ {', '.join(sorted(set(cls)))} }} from '{imp}';" for imp, cls in sorted(by_import.items())]
open(os.path.join(ENTITIES_DIR, 'espejo.existing.ts'), 'w', encoding='utf-8').write('\n'.join(ge) + '\n')

# `existing-entities.json` pasa de inventario escrito a mano a artefacto derivado del disco. Lo
# siguen leyendo los 14 specs del espejo, que solo usan sus CLAVES para afirmar que ningún espejo
# duplica una tabla que ya tiene entity en el repo.
inventario = {'_meta': 'GENERADO por scripts/espejo/generate-espejo.py desde el disco (entities del repo menos las del registro de espejos). No editar a mano.'}
inventario.update(dict(sorted(existing.items())))
json.dump(inventario, open(EXISTING_PATH, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print(f'{MODULE}: {n_new} espejos creados, {n_exist} entities existentes documentadas -> {os.path.relpath(OUTDIR, ROOT)}')
