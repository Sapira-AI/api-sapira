# VATs Genéricos para Facturación de Exportación

## Problema

En la facturación de exportación, muchos países utilizan **VATs genéricos** que se asignan a múltiples clientes. Por ejemplo:

-   **Chile**: `5555555-5` (VAT genérico para exportación)
-   Otros países tienen VATs similares

### Desafío Técnico

Cuando se integran partners desde Odoo a Sapira, el sistema normalmente:

1. Busca por **VAT** para determinar si el cliente ya existe
2. Si existe, actualiza el `odoo_partner_id`
3. Si no existe, crea un nuevo cliente

**El problema**: Con VATs genéricos, esta lógica falla porque:

-   Múltiples clientes de exportación comparten el mismo VAT
-   La búsqueda por VAT retorna resultados ambiguos
-   Las reglas de unicidad en BD pueden rechazar inserciones

## Solución Implementada

### 1. Array de VATs Genéricos

Se creó un array constante con los VATs genéricos conocidos:

```typescript
// generic-vats.constant.ts
export const GENERIC_EXPORT_VATS = [
	'5555555-5', // Chile - VAT genérico para exportación
	'55555555', // Chile - Variante sin guión
	'00000000-0', // Chile - VAT genérico alternativo
	// ... más VATs genéricos
];
```

### 2. Función de Validación

```typescript
export function isGenericExportVat(vat: string | null | undefined): boolean {
	if (!vat) return false;
	const normalizedVat = vat.trim().toUpperCase();
	return GENERIC_EXPORT_VATS.some((genericVat) => normalizedVat === genericVat.toUpperCase());
}
```

### 3. Lógica de Procesamiento Modificada

#### En `odoo-partners.service.ts` (Determinación de Status)

```typescript
const isGenericVat = isGenericExportVat(partnerVat);

// Si es VAT genérico, NO buscar solo por VAT
if (isGenericVat) {
	// Solo buscar por VAT + odoo_partner_id (combinación única)
	// NO buscar solo por VAT
	return {
		status: 'create',
		notes: `Partner nuevo con VAT genérico de exportación (${partnerVat})`,
	};
}

// Para VATs normales, buscar por VAT solo
const existingByVat = await this.clientEntitiesRepository.findOne({
	where: { tax_id: partnerVat, holding_id: holdingId },
});
```

#### En `partners-processor.service.ts` (Procesamiento de Updates)

```typescript
const isGenericVat = isGenericExportVat(partnerVat);

// Buscar por VAT + Odoo ID (siempre)
existingClient = await this.clientEntitiesRepository.findOne({
	where: {
		tax_id: partnerVat,
		holding_id: dto.holding_id,
		odoo_partner_id: partner.odoo_id,
	},
});

// Solo si NO es VAT genérico, buscar por VAT solo
if (!existingClient && !isGenericVat) {
	existingClient = await this.clientEntitiesRepository.findOne({
		where: { tax_id: partnerVat, holding_id: dto.holding_id },
	});
}
```

## Flujo de Procesamiento

### Para VATs Normales

```
1. Buscar por VAT + odoo_partner_id
   ├─ Si existe → UPDATE
   └─ Si no existe
       └─ Buscar solo por VAT
           ├─ Si existe → UPDATE (vincular odoo_partner_id)
           └─ Si no existe → CREATE
```

### Para VATs Genéricos

```
1. Buscar por VAT + odoo_partner_id
   ├─ Si existe → UPDATE
   └─ Si no existe → CREATE

   ⚠️ NUNCA buscar solo por VAT genérico
```

## Beneficios

1. ✅ **Múltiples clientes** pueden compartir el mismo VAT genérico
2. ✅ **Identificación única** mediante `VAT + odoo_partner_id`
3. ✅ **No hay conflictos** de unicidad en BD
4. ✅ **Trazabilidad** completa de cada cliente de exportación
5. ✅ **Escalable** - fácil agregar nuevos VATs genéricos

## Agregar Nuevos VATs Genéricos

Para agregar un nuevo VAT genérico:

```typescript
// En generic-vats.constant.ts
export const GENERIC_EXPORT_VATS = [
	'5555555-5', // Chile
	'NUEVO-VAT', // Tu nuevo VAT genérico
	// ...
];
```

## Logs de Diagnóstico

El sistema genera logs específicos para VATs genéricos:

```
⚠️ VAT genérico detectado: 5555555-5. No se buscará solo por VAT.
⚠️ VAT genérico 5555555-5: No se encontró con Odoo ID 12345. No se buscará solo por VAT.
```

Esto facilita el debugging y monitoreo de la integración.

## Casos de Uso

### Caso 1: Nuevo Cliente de Exportación

```
Partner en Odoo:
- ID: 16252
- VAT: 5555555-5
- Nombre: "Cliente Export USA"

Resultado:
✓ Se detecta VAT genérico
✓ No se busca por VAT solo
✓ Se crea nuevo cliente con odoo_partner_id = 16252
```

### Caso 2: Actualización de Cliente Existente

```
Cliente en Sapira:
- tax_id: 5555555-5
- odoo_partner_id: 16252

Partner en Odoo (actualizado):
- ID: 16252
- VAT: 5555555-5
- Email: nuevo@email.com

Resultado:
✓ Se busca por VAT + odoo_partner_id
✓ Se encuentra el cliente
✓ Se actualiza con nuevos datos
```

### Caso 3: Múltiples Clientes con Mismo VAT

```
Cliente A:
- tax_id: 5555555-5
- odoo_partner_id: 16252

Cliente B:
- tax_id: 5555555-5
- odoo_partner_id: 16253

Resultado:
✓ Ambos coexisten sin conflictos
✓ Cada uno se identifica por VAT + odoo_partner_id
```

## Consideraciones de Base de Datos

### Índices Recomendados

Para optimizar las búsquedas con VATs genéricos:

```sql
-- Índice compuesto para búsqueda por VAT + odoo_partner_id
CREATE INDEX idx_client_entities_vat_odoo_partner
ON client_entities(tax_id, odoo_partner_id, holding_id);

-- Índice para búsqueda por odoo_partner_id
CREATE INDEX idx_client_entities_odoo_partner
ON client_entities(odoo_partner_id, holding_id);
```

### Restricciones de Unicidad

**NO** crear restricción de unicidad solo en `tax_id`, ya que los VATs genéricos deben permitir duplicados.

Si existe una restricción de unicidad, debe ser:

```sql
-- Correcto: Permite múltiples registros con mismo VAT pero diferente odoo_partner_id
UNIQUE (tax_id, odoo_partner_id, holding_id)

-- Incorrecto: Bloquearía VATs genéricos
UNIQUE (tax_id, holding_id)
```

## Mantenimiento

### Agregar Nuevo País

1. Identificar el VAT genérico del país
2. Agregarlo a `GENERIC_EXPORT_VATS`
3. Documentar en este README

### Monitoreo

Revisar logs periódicamente para:

-   Detectar nuevos VATs genéricos no registrados
-   Verificar que la lógica funciona correctamente
-   Identificar patrones de uso

## Referencias

-   Archivo principal: `generic-vats.constant.ts`
-   Servicio de partners: `odoo-partners.service.ts`
-   Procesador: `partners-processor.service.ts`
