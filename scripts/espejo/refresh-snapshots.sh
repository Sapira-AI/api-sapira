#!/usr/bin/env bash
#
# Refresca los snapshots de prod contra los que los specs miden las entities.
#
# Por qué existe: el refresco eran cuatro pasos sueltos y sin documentar (capturar el catálogo,
# construir los snapshots por módulo, regenerar los 16 módulos en DOS pasadas, formatear). Desde que
# el generador ya no reescribe las entities promovidas, el snapshot es el detector de deriva: si
# refrescarlo cuesta cuatro comandos, nadie lo hace y el spec queda en rojo hasta que alguien edita
# el snapshot a mano, que es justo lo que no se puede hacer.
#
# CUÁNDO se corre: DESPUÉS de aplicar un cambio a producción, nunca antes. El snapshot describe lo
# que prod tiene; refrescarlo con la base sin actualizar es tapar la deriva en vez de resolverla.
#
# Uso (desde api-sapira/):
#   DOTENV_CONFIG_PATH=.env.prod.db yarn schema:snapshot --target production
#
set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ " $* " != *" --target "* ]]; then
	echo "Falta --target <entorno>. Ejemplo:" >&2
	echo "  DOTENV_CONFIG_PATH=.env.prod.db yarn schema:snapshot --target production" >&2
	exit 1
fi

ESPEJO=scripts/espejo
RAW=$ESPEJO/snapshots/raw
MODULOS=(base-tenancy fx clientes cotizaciones-catalogo contratos facturacion revenue legacy conciliacion
	integraciones/salesforce integraciones/odoo integraciones/stripe integraciones/otras automatizaciones-ia
	suscripciones sii)

echo "① Capturando el catálogo (solo lectura)…"
npx ts-node -r tsconfig-paths/register scripts/schema-as-code/fetch-catalog.ts "$@"

echo "② Metadata de las entities del repo (sin conexión)…"
TABLAS=$(python3 -c "import json;print(' '.join(t for t in json.load(open('$RAW/catalog.json'))['tables']))")
# shellcheck disable=SC2086
npx ts-node -r tsconfig-paths/register $ESPEJO/extract-existing-metadata.ts $TABLAS > "$RAW/existing-metadata.json"

echo "③ Snapshots por módulo…"
python3 $ESPEJO/build-snapshots.py "$RAW/list-tables.json" "$RAW/catalog.json" \
	$ESPEJO/module-map.json $ESPEJO/existing-entities.json $ESPEJO/snapshots "$RAW/existing-metadata.json"

echo "④ Regenerando los 16 módulos (dos pasadas: las FKs entre módulos lo exigen)…"
for _pasada in 1 2; do
	for modulo in "${MODULOS[@]}"; do
		python3 $ESPEJO/generate-espejo.py "$modulo" > /dev/null
	done
done

echo "⑤ Formateando (el generador escribe comillas dobles; el repo usa prettier)…"
yarn eslint --fix "src/databases/postgresql/entities/**/*.ts" > /dev/null

echo
echo "Listo. Revisá el diff: si cambió un *.prod-snapshot.ts, eso es lo que cambió en la base."
echo "Las entities promovidas NO se tocan: su fuente de verdad es el repo."
