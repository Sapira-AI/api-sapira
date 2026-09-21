# ✅ Implementación: Campo "Términos y Condiciones" en Contratos

## 📋 Resumen

Se implementó exitosamente el campo `invoice_terms_and_conditions` en la tabla `contracts`, que permite agregar términos y condiciones personalizados que se enviarán automáticamente en el campo `narration` de las facturas de Odoo.

## 🔧 Cambios Implementados

### 1. Base de Datos

**Archivo**: `sapira-ai/supabase/migrations/20260422153000_add_invoice_terms_to_contracts.sql`

```sql
ALTER TABLE contracts
ADD COLUMN IF NOT EXISTS invoice_terms_and_conditions TEXT;

COMMENT ON COLUMN contracts.invoice_terms_and_conditions IS
'Términos y condiciones que se incluirán en el campo narration de las facturas generadas por este contrato. Acepta HTML para formato enriquecido.';
```

### 2. Backend - Entidad Contract

**Archivo**: `api-sapira-ai/src/modules/invoices/entities/contract.entity.ts` (NUEVO)

```typescript
@Entity('contracts')
export class Contract {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'text', nullable: true })
	invoice_terms_and_conditions?: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'text', nullable: true })
	contract_number?: string;

	@Column({ type: 'text', nullable: true })
	status?: string;
}
```

### 3. Backend - Servicio de Facturas

**Archivo**: `api-sapira-ai/src/modules/invoices/invoice-scheduler.service.ts`

#### Cambios realizados:

1. **Import de Contract**:

```typescript
import { Contract } from './entities/contract.entity';
```

2. **Interface InvoiceWithRelations**:

```typescript
interface InvoiceWithRelations extends Invoice {
	clientEntity?: ClientEntity;
	company?: Company;
	items?: InvoiceItem[];
	contract?: Contract; // ← NUEVO
}
```

3. **Inyección de ContractRepository**:

```typescript
constructor(
    // ... otros repositorios
    @InjectRepository(Contract)
    private readonly contractRepository: Repository<Contract>,
    // ... servicios
) {}
```

4. **Método `getInvoicesToSend()`** - Cargar contrato:

```typescript
const contract = await this.contractRepository.findOne({
	where: { id: invoice.contract_id },
});

(invoice as InvoiceWithRelations).contract = contract;
```

5. **Método `getInvoiceWithRelations()`** - Cargar contrato:

```typescript
const contract = await this.contractRepository.findOne({
	where: { id: invoice.contract_id },
});

(invoice as InvoiceWithRelations).contract = contract;
```

6. **Método `mapInvoiceToOdooFormat()`** - Usar términos del contrato:

```typescript
// Usar términos y condiciones del contrato si existen, sino usar notas de la factura
const narration = invoice.contract?.invoice_terms_and_conditions || invoice.notes || undefined;

return {
	// ... otros campos
	narration: narration, // ← MODIFICADO
	// ... otros campos
};
```

### 4. Backend - Módulo de Facturas

**Archivo**: `api-sapira-ai/src/modules/invoices/invoices.module.ts`

```typescript
import { Contract } from './entities/contract.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Invoice,
            InvoiceItem,
            Contract,  // ← NUEVO
            ClientEntity,
            Company,
            Product,
            OdooProductMapping
        ]),
        // ... otros módulos
    ],
    // ...
})
```

## 🎯 Comportamiento

### Lógica de Prioridad para `narration`

```
1. contract.invoice_terms_and_conditions (si existe)
   ↓
2. invoice.notes (si no hay términos en contrato)
   ↓
3. undefined (si ninguno existe)
```

### Flujo Completo

```
1. Usuario edita contrato en UI
   ├─ Agrega texto en "Términos y condiciones de factura"
   ├─ Puede usar formato HTML (negrita, listas, etc.)
   └─ Se guarda en contracts.invoice_terms_and_conditions

2. Sistema genera factura (trigger de contrato)
   ├─ Factura creada con contract_id
   └─ invoice.notes puede estar vacío

3. Usuario envía factura a Odoo
   ├─ getInvoicesToSend() carga el contrato
   ├─ mapInvoiceToOdooFormat() usa contract.invoice_terms_and_conditions
   └─ Si no existe → usa invoice.notes (fallback)

4. Odoo recibe factura
   └─ Campo narration con términos del contrato (HTML)
```

## 📊 Ejemplo de Uso

### Escenario: Contrato SimpliRoute México

**Contrato configurado**:

```html
<p>
	Licencia Mensual SimpliRoute<br />
	Clave SAT: 81112501 - Servicio de licencias del software del computador<br />
	02 - Sí objeto de impuesto
</p>
```

**Factura generada**:

-   `invoice.notes` = null
-   `contract.invoice_terms_and_conditions` = (HTML arriba)

**Enviado a Odoo**:

```json
{
  "partner_id": 6157,
  "company_id": 4,
  "move_type": "out_invoice",
  "narration": "<p>Licencia Mensual SimpliRoute<br>Clave SAT: 81112501 - Servicio de licencias del software del computador<br>02 - Sí objeto de impuesto</p>",
  "invoice_line_ids": [...]
}
```

## ✅ Compatibilidad

-   ✅ **Facturas existentes**: Seguirán usando `invoice.notes` si el contrato no tiene términos configurados
-   ✅ **Contratos sin términos**: Comportamiento actual sin cambios (usa `invoice.notes`)
-   ✅ **Contratos con términos**: Nuevo comportamiento automático (usa `contract.invoice_terms_and_conditions`)
-   ✅ **HTML**: Odoo acepta HTML en el campo `narration`

## 📁 Archivos Creados/Modificados

### Backend

1. ✅ `sapira-ai/supabase/migrations/20260422153000_add_invoice_terms_to_contracts.sql` (NUEVO)
2. ✅ `api-sapira-ai/src/modules/invoices/entities/contract.entity.ts` (NUEVO)
3. ✅ `api-sapira-ai/src/modules/invoices/invoice-scheduler.service.ts` (MODIFICADO)
    - Import Contract
    - Interface InvoiceWithRelations
    - Inyección contractRepository
    - Método getInvoicesToSend()
    - Método getInvoiceWithRelations()
    - Método mapInvoiceToOdooFormat()
4. ✅ `api-sapira-ai/src/modules/invoices/invoices.module.ts` (MODIFICADO)
    - Import Contract
    - TypeOrmModule.forFeature()

### Frontend (PENDIENTE)

5. ⏳ Formulario de contrato - Agregar campo `invoice_terms_and_conditions`
6. ⏳ Componente RichTextEditor - Editor de texto enriquecido

## 📋 Próximos Pasos

### 1. Ejecutar Migración

```bash
cd sapira-ai
supabase db push
```

### 2. Implementar UI (Frontend)

Agregar campo de texto enriquecido en el formulario de edición de contratos:

```typescript
<FormField
  control={form.control}
  name="invoice_terms_and_conditions"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Términos y Condiciones de Factura</FormLabel>
      <FormDescription>
        Este texto se incluirá en el campo "Narración" de las facturas enviadas a Odoo.
      </FormDescription>
      <FormControl>
        <RichTextEditor
          value={field.value}
          onChange={field.onChange}
          placeholder="Ej: Licencia Mensual SimpliRoute..."
        />
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>
```

### 3. Probar Funcionalidad

1. Editar un contrato y agregar términos y condiciones
2. Generar una factura desde ese contrato
3. Enviar la factura a Odoo
4. Verificar que el campo `narration` contenga los términos del contrato

### 4. Verificar en Logs

```
Factura INV-001: usando términos del contrato CON-001
narration: <p>Licencia Mensual SimpliRoute...</p>
```

## 🎨 Recomendaciones para UI

### Editor de Texto Enriquecido

Usar **TipTap** (recomendado):

```bash
npm install @tiptap/react @tiptap/starter-kit
```

Características:

-   ✅ Moderno y extensible
-   ✅ Soporte para HTML
-   ✅ Fácil integración con React
-   ✅ Toolbar personalizable

### Alternativas:

-   **Quill** - Popular, maduro
-   **Draft.js** - De Facebook
-   **Slate** - Muy flexible

## 📝 Notas Importantes

1. **HTML en Odoo**: Odoo acepta y renderiza HTML en el campo `narration`
2. **Campo opcional**: Si no se configura, el sistema usa `invoice.notes` (comportamiento actual)
3. **No afecta líneas**: El texto NO se concatena a cada línea de factura, solo va en `narration`
4. **Prioridad clara**: `contract.invoice_terms_and_conditions` > `invoice.notes` > `undefined`
5. **Por contrato**: Cada contrato puede tener sus propios términos personalizados

## ✨ Beneficios

1. ✅ **Centralizado**: Términos definidos una vez en el contrato
2. ✅ **Automático**: Se aplica a todas las facturas del contrato
3. ✅ **Flexible**: Acepta HTML para formato enriquecido
4. ✅ **Compatible**: No rompe funcionalidad existente
5. ✅ **Editable**: Fácil de modificar en la UI del contrato
6. ✅ **Específico por país**: Cada contrato puede tener términos según su jurisdicción

## 🔮 Mejoras Futuras

1. **Templates predefinidos**: Crear plantillas de términos por país/industria
2. **Variables dinámicas**: Permitir `{{contract_number}}`, `{{client_name}}`, etc.
3. **Versionado**: Historial de cambios en términos y condiciones
4. **Preview**: Vista previa de cómo se verá en Odoo
5. **Validación**: Verificar que el HTML sea válido antes de guardar
