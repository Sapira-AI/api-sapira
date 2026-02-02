[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ================================================================================
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🚀 INICIO DE PROCESAMIENTO DE PARTNERS
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📋 Holding ID: f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🗺️ Mapping ID: 47cff583-ec08-402b-a30b-bc947314bf2d
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🎯 Partner IDs específicos: Todos
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ================================================================================
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔍 Buscando configuración de mapeo...
query: SELECT "FieldMapping"."id" AS "FieldMapping_id", "FieldMapping"."holding_id" AS "FieldMapping_holding_id", "FieldMapping"."source_model" AS "FieldMapping_source_model", "FieldMapping"."target_table" AS "FieldMapping_target_table", "FieldMapping"."mapping_name" AS "FieldMapping_mapping_name", "FieldMapping"."mapping_config" AS "FieldMapping_mapping_config", "FieldMapping"."is_active" AS "FieldMapping_is_active", "FieldMapping"."created_by" AS "FieldMapping_created_by", "FieldMapping"."created_at" AS "FieldMapping_created_at", "FieldMapping"."updated_at" AS "FieldMapping_updated_at", "FieldMapping"."mapping_type" AS "FieldMapping_mapping_type", "FieldMapping"."secondary_source_model" AS "FieldMapping_secondary_source_model", "FieldMapping"."secondary_target_table" AS "FieldMapping_secondary_target_table", "FieldMapping"."transformation_type" AS "FieldMapping_transformation_type", "FieldMapping"."transformation_config" AS "FieldMapping_transformation_config" FROM "field_mappings" "FieldMapping" WHERE (("FieldMapping"."id" = $1) AND ("FieldMapping"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["47cff583-ec08-402b-a30b-bc947314bf2d","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ✅ Mapeo encontrado: Mapeo Partners 2/2/2026
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📊 Configuración de mapeo:
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] {
"mappings": {
"email": {
"source": "email_normalized",
"sourceField": {
"name": "email_normalized",
"type": "string",
"example": "recepcion.facturas@ibero.edu.co",
"isArray": false,
"transformations": [
{
"label": "Valor directo",
"value": "email_normalized"
}
],
"selectedTransformation": "email_normalized"
},
"transformation": "email_normalized"
},
"phone": {
"source": "phone_sanitized",
"sourceField": {
"name": "phone_sanitized",
"type": "boolean",
"example": false,
"isArray": false,
"transformations": [
{
"label": "Valor directo",
"value": "phone_sanitized"
}
],
"selectedTransformation": "phone_sanitized"
},
"transformation": "phone_sanitized"
},
"tax_id": {
"source": "vat",
"sourceField": {
"name": "vat",
"type": "string",
"example": "860503837-7",
"isArray": false,
"transformations": [
{
"label": "Valor directo",
"value": "vat"
}
],
"selectedTransformation": "vat"
},
"transformation": "vat"
},
"country": {
"source": "country_id[1]",
"sourceField": {
"name": "country_id[1]",
"type": "object",
"example": [
49,
"Colombia"
],
"isArray": true,
"transformations": [
{
"label": "Valor completo",
"value": "country_id"
},
{
"label": "Primer elemento [0]",
"value": "country_id[0]"
},
{
"label": "Segundo elemento [1]",
"value": "country_id[1]"
}
],
"selectedTransformation": "country_id[1]"
},
"transformation": "country_id[1]"
},
"legal_name": {
"source": "name",
"sourceField": {
"name": "name",
"type": "string",
"example": "Corporación Universitaria Iberoamericana",
"isArray": false,
"transformations": [
{
"label": "Valor directo",
"value": "name"
}
],
"selectedTransformation": "name"
},
"transformation": "name"
},
"client_number": {
"source": "id",
"sourceField": {
"name": "id",
"type": "number",
"example": 6888,
"isArray": false,
"transformations": [
{
"label": "Valor directo",
"value": "id"
}
],
"selectedTransformation": "id"
},
"transformation": "id"
},
"legal_address": {
"source": "contact_address_complete",
"sourceField": {
"name": "contact_address_complete",
"type": "string",
"example": "Carrera CL 67 5 27, 110110 Bogotá D.C., Bogotá, Colombia",
"isArray": false,
"transformations": [
{
"label": "Valor directo",
"value": "contact_address_complete"
}
],
"selectedTransformation": "contact_address_complete"
},
"transformation": "contact_address_complete"
}
},
"created_at": "2026-02-02T13:26:50.294Z",
"field_count": 7
}
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔧 Total de campos a mapear: 7
query: SELECT "partner"."id" AS "partner_id", "partner"."odoo_id" AS "partner_odoo_id", "partner"."raw_data" AS "partner_raw_data", "partner"."processed_at" AS "partner_processed_at", "partner"."sync_batch_id" AS "partner_sync_batch_id", "partner"."holding_id" AS "partner_holding_id", "partner"."created_at" AS "partner_created_at", "partner"."updated_at" AS "partner_updated_at", "partner"."processing_status" AS "partner_processing_status", "partner"."integration_batch_id" AS "partner_integration_batch_id", "partner"."last_integrated_at" AS "partner_last_integrated_at", "partner"."integration_notes" AS "partner_integration_notes" FROM "odoo_partners_stg" "partner" WHERE "partner"."holding_id" = $1 AND "partner"."processing_status" IN ($2, $3, $4) ORDER BY "partner"."created_at" DESC -- PARAMETERS: ["f6e3cb81-8b4a-451e-8402-573e47688d45","create","update","processed"]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📦 Partners encontrados: 21
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService]
================================================================================
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔄 INICIANDO PROCESAMIENTO DE PARTNERS
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ================================================================================

## [Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService]

[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔍 Procesando Partner #14852 | Odoo ID: 6888
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:48 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=6888, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ email = "recepcion.facturas@ibero.edu.co"
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ tax_id = "860503837-7"
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ country = "Colombia"
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ legal_name = "Corporación Universitaria Iberoamericana"
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ client_number = 6888
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ legal_address = "Carrera CL 67 5 27, 110110 Bogotá D.C., Bogotá, Colombia"
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] {
"odoo_partner_id": 6888,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "recepcion.facturas@ibero.edu.co",
"phone": false,
"tax_id": "860503837-7",
"country": "Colombia",
"legal_name": "Corporación Universitaria Iberoamericana",
"client_number": 6888,
"legal_address": "Carrera CL 67 5 27, 110110 Bogotá D.C., Bogotá, Colombia"
}
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 860503837-7 y Odoo ID: 6888
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["860503837-7","f6e3cb81-8b4a-451e-8402-573e47688d45",6888]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=3365f550-7335-43ce-9f6b-d034f3dcfd54
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [6888,"f6e3cb81-8b4a-451e-8402-573e47688d45","recepcion.facturas@ibero.edu.co",false,"860503837-7","Colombia","Corporación Universitaria Iberoamericana",6888,"Carrera CL 67 5 27, 110110 Bogotá D.C., Bogotá, Colombia","3365f550-7335-43ce-9f6b-d034f3dcfd54"]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["3365f550-7335-43ce-9f6b-d034f3dcfd54"]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] {
"id": "3365f550-7335-43ce-9f6b-d034f3dcfd54",
"client_id": "8368ee33-f1ac-4425-8310-2e884cb90099",
"legal_name": "Corporación Universitaria Iberoamericana",
"tax_id": "860503837-7",
"country": "Colombia",
"legal_address": "Carrera CL 67 5 27, 110110 Bogotá D.C., Bogotá, Colombia",
"email": "recepcion.facturas@ibero.edu.co",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "6888",
"odoo_partner_id": 6888
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:55.655Z","Cliente actualizado exitosamente - ID: 3365f550-7335-43ce-9f6b-d034f3dcfd54",14852]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔍 Procesando Partner #14851 | Odoo ID: 472
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:48 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=472, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ tax_id = "5555555-5"
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ country = "Peru"
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ legal_name = "INSTITUTO SUPERIOR SAN IGNACIO DE LOYOLA"
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ client_number = 472
[Nest] 94839 - 02/02/2026, 10:38:55 DEBUG [PartnersProcessorService] ✓ legal_address = "Av. la Fontana 955, Lima, Perú"
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] {
"odoo_partner_id": 472,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "5555555-5",
"country": "Peru",
"legal_name": "INSTITUTO SUPERIOR SAN IGNACIO DE LOYOLA",
"client_number": 472,
"legal_address": "Av. la Fontana 955, Lima, Perú"
}
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 5555555-5 y Odoo ID: 472
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45",472]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [472,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [472,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Peru","INSTITUTO SUPERIOR SAN IGNACIO DE LOYOLA",472,"Av. la Fontana 955, Lima, Perú","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:55 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"id": "f7f70b89-42fd-4b1e-b84c-639dca88b9b0",
"client_id": null,
"legal_name": "INSTITUTO SUPERIOR SAN IGNACIO DE LOYOLA",
"tax_id": "5555555-5",
"country": "Peru",
"legal_address": "Av. la Fontana 955, Lima, Perú",
"email": "false",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "472",
"odoo_partner_id": 472
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:56.022Z","Cliente actualizado exitosamente - ID: f7f70b89-42fd-4b1e-b84c-639dca88b9b0",14851]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Procesando Partner #14850 | Odoo ID: 519
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:47 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=519, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ email = "70300000-2@prd.inbox.febos.cl"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ phone = 56222400300
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ tax_id = "70300000-2"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ legal_name = "FUNDACION CHILE"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ client_number = 519
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ legal_address = "Parque Antonio Rabat Sur 6165, Vitacura, Santiago, Metropolitana, Chile"
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"odoo_partner_id": 519,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "70300000-2@prd.inbox.febos.cl",
"phone": 56222400300,
"tax_id": "70300000-2",
"country": "Chile",
"legal_name": "FUNDACION CHILE",
"client_number": 519,
"legal_address": "Parque Antonio Rabat Sur 6165, Vitacura, Santiago, Metropolitana, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 70300000-2 y Odoo ID: 519
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["70300000-2","f6e3cb81-8b4a-451e-8402-573e47688d45",519]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["70300000-2","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [519,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=599ce138-43f2-4df4-ae11-b161d1945457
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=599ce138-43f2-4df4-ae11-b161d1945457
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [519,"f6e3cb81-8b4a-451e-8402-573e47688d45","70300000-2@prd.inbox.febos.cl",56222400300,"70300000-2","Chile","FUNDACION CHILE",519,"Parque Antonio Rabat Sur 6165, Vitacura, Santiago, Metropolitana, Chile","599ce138-43f2-4df4-ae11-b161d1945457"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["599ce138-43f2-4df4-ae11-b161d1945457"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"id": "599ce138-43f2-4df4-ae11-b161d1945457",
"client_id": null,
"legal_name": "FUNDACION CHILE",
"tax_id": "70300000-2",
"country": "Chile",
"legal_address": "Parque Antonio Rabat Sur 6165, Vitacura, Santiago, Metropolitana, Chile",
"email": "70300000-2@prd.inbox.febos.cl",
"phone": "56222400300",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "519",
"odoo_partner_id": 519
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:56.391Z","Cliente actualizado exitosamente - ID: 599ce138-43f2-4df4-ae11-b161d1945457",14850]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Procesando Partner #14849 | Odoo ID: 523
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:46 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=523, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ tax_id = "71551500-8"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ legal_name = "UNIVERSIDAD SANTO TOMAS"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ client_number = 523
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ legal_address = "Av. Ejército 146, Santiago, Chile"
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"odoo_partner_id": 523,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "71551500-8",
"country": "Chile",
"legal_name": "UNIVERSIDAD SANTO TOMAS",
"client_number": 523,
"legal_address": "Av. Ejército 146, Santiago, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 71551500-8 y Odoo ID: 523
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["71551500-8","f6e3cb81-8b4a-451e-8402-573e47688d45",523]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["71551500-8","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [523,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=436f838e-939d-498d-9857-6bf8d5d6d099
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=436f838e-939d-498d-9857-6bf8d5d6d099
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [523,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"71551500-8","Chile","UNIVERSIDAD SANTO TOMAS",523,"Av. Ejército 146, Santiago, Chile","436f838e-939d-498d-9857-6bf8d5d6d099"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["436f838e-939d-498d-9857-6bf8d5d6d099"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"id": "436f838e-939d-498d-9857-6bf8d5d6d099",
"client_id": null,
"legal_name": "UNIVERSIDAD SANTO TOMAS",
"tax_id": "71551500-8",
"country": "Chile",
"legal_address": "Av. Ejército 146, Santiago, Chile",
"email": "false",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "523",
"odoo_partner_id": 523
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:56.758Z","Cliente actualizado exitosamente - ID: 436f838e-939d-498d-9857-6bf8d5d6d099",14849]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Procesando Partner #14848 | Odoo ID: 539
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:46 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=539, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ tax_id = "65175239-6"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ legal_name = "INSTITUTO PROFESIONAL SANTO TOMAS"
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ client_number = 539
[Nest] 94839 - 02/02/2026, 10:38:56 DEBUG [PartnersProcessorService] ✓ legal_address = "Av. Vicuña Mackenna 4835, Santiago, Chile"
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] {
"odoo_partner_id": 539,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "65175239-6",
"country": "Chile",
"legal_name": "INSTITUTO PROFESIONAL SANTO TOMAS",
"client_number": 539,
"legal_address": "Av. Vicuña Mackenna 4835, Santiago, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 65175239-6 y Odoo ID: 539
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["65175239-6","f6e3cb81-8b4a-451e-8402-573e47688d45",539]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["65175239-6","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:56 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [539,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=e9ff5aa4-53bb-48e6-ae24-981712f42268
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=e9ff5aa4-53bb-48e6-ae24-981712f42268
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [539,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"65175239-6","Chile","INSTITUTO PROFESIONAL SANTO TOMAS",539,"Av. Vicuña Mackenna 4835, Santiago, Chile","e9ff5aa4-53bb-48e6-ae24-981712f42268"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["e9ff5aa4-53bb-48e6-ae24-981712f42268"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"id": "e9ff5aa4-53bb-48e6-ae24-981712f42268",
"client_id": null,
"legal_name": "INSTITUTO PROFESIONAL SANTO TOMAS",
"tax_id": "65175239-6",
"country": "Chile",
"legal_address": "Av. Vicuña Mackenna 4835, Santiago, Chile",
"email": "false",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "539",
"odoo_partner_id": 539
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:57.124Z","Cliente actualizado exitosamente - ID: e9ff5aa4-53bb-48e6-ae24-981712f42268",14848]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Procesando Partner #14847 | Odoo ID: 538
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:45 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=538, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ tax_id = "65175242-6"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ legal_name = "CENTRO DE FORMACION TECNICA SANTO TOMAS LIMITADA"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ client_number = 538
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ legal_address = "Av Ejercito 146, Santiago, Chile"
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"odoo_partner_id": 538,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "65175242-6",
"country": "Chile",
"legal_name": "CENTRO DE FORMACION TECNICA SANTO TOMAS LIMITADA",
"client_number": 538,
"legal_address": "Av Ejercito 146, Santiago, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 65175242-6 y Odoo ID: 538
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["65175242-6","f6e3cb81-8b4a-451e-8402-573e47688d45",538]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["65175242-6","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [538,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=760c92f6-3f98-4f71-8178-bb5bc14ae05e
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=760c92f6-3f98-4f71-8178-bb5bc14ae05e
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [538,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"65175242-6","Chile","CENTRO DE FORMACION TECNICA SANTO TOMAS LIMITADA",538,"Av Ejercito 146, Santiago, Chile","760c92f6-3f98-4f71-8178-bb5bc14ae05e"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["760c92f6-3f98-4f71-8178-bb5bc14ae05e"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"id": "760c92f6-3f98-4f71-8178-bb5bc14ae05e",
"client_id": null,
"legal_name": "CENTRO DE FORMACION TECNICA SANTO TOMAS LIMITADA",
"tax_id": "65175242-6",
"country": "Chile",
"legal_address": "Av Ejercito 146, Santiago, Chile",
"email": "false",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "538",
"odoo_partner_id": 538
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:57.503Z","Cliente actualizado exitosamente - ID: 760c92f6-3f98-4f71-8178-bb5bc14ae05e",14847]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Procesando Partner #14846 | Odoo ID: 7267
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:44 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=7267, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ email = "tributario@escs.cl"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ tax_id = "87894800-9"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ legal_name = "INSTITUTO PROFESIONAL DEL COMERCIO LIMITADA"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ client_number = 7267
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ legal_address = "Avenida Ejército Libertador 306, Santiago, Metropolitana, Chile"
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"odoo_partner_id": 7267,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "tributario@escs.cl",
"phone": false,
"tax_id": "87894800-9",
"country": "Chile",
"legal_name": "INSTITUTO PROFESIONAL DEL COMERCIO LIMITADA",
"client_number": 7267,
"legal_address": "Avenida Ejército Libertador 306, Santiago, Metropolitana, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 87894800-9 y Odoo ID: 7267
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["87894800-9","f6e3cb81-8b4a-451e-8402-573e47688d45",7267]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["87894800-9","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [7267,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=f385687e-6ca5-4f4e-9cb4-4083980e955a
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f385687e-6ca5-4f4e-9cb4-4083980e955a
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [7267,"f6e3cb81-8b4a-451e-8402-573e47688d45","tributario@escs.cl",false,"87894800-9","Chile","INSTITUTO PROFESIONAL DEL COMERCIO LIMITADA",7267,"Avenida Ejército Libertador 306, Santiago, Metropolitana, Chile","f385687e-6ca5-4f4e-9cb4-4083980e955a"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["f385687e-6ca5-4f4e-9cb4-4083980e955a"]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"id": "f385687e-6ca5-4f4e-9cb4-4083980e955a",
"client_id": null,
"legal_name": "INSTITUTO PROFESIONAL DEL COMERCIO LIMITADA",
"tax_id": "87894800-9",
"country": "Chile",
"legal_address": "Avenida Ejército Libertador 306, Santiago, Metropolitana, Chile",
"email": "tributario@escs.cl",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "7267",
"odoo_partner_id": 7267
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:57.863Z","Cliente actualizado exitosamente - ID: f385687e-6ca5-4f4e-9cb4-4083980e955a",14846]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Procesando Partner #14845 | Odoo ID: 6878
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:44 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=6878, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ email = "maria.perez@ceipa.edu.co"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ tax_id = "890910961-7"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ country = "Colombia"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ legal_name = "Fundación Universitaria CEIPA"
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ client_number = 6878
[Nest] 94839 - 02/02/2026, 10:38:57 DEBUG [PartnersProcessorService] ✓ legal_address = "Calle 77 Sur #No 40 -165, 055413 SABANETA, Antioquia, Colombia"
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] {
"odoo_partner_id": 6878,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "maria.perez@ceipa.edu.co",
"phone": false,
"tax_id": "890910961-7",
"country": "Colombia",
"legal_name": "Fundación Universitaria CEIPA",
"client_number": 6878,
"legal_address": "Calle 77 Sur #No 40 -165, 055413 SABANETA, Antioquia, Colombia"
}
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 890910961-7 y Odoo ID: 6878
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["890910961-7","f6e3cb81-8b4a-451e-8402-573e47688d45",6878]
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=6c4ccb7b-5b09-49ac-aedd-10f8ccd78568
[Nest] 94839 - 02/02/2026, 10:38:57 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [6878,"f6e3cb81-8b4a-451e-8402-573e47688d45","maria.perez@ceipa.edu.co",false,"890910961-7","Colombia","Fundación Universitaria CEIPA",6878,"Calle 77 Sur #No 40 -165, 055413 SABANETA, Antioquia, Colombia","6c4ccb7b-5b09-49ac-aedd-10f8ccd78568"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["6c4ccb7b-5b09-49ac-aedd-10f8ccd78568"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"id": "6c4ccb7b-5b09-49ac-aedd-10f8ccd78568",
"client_id": "9eeee9db-2dd8-4653-bb76-1a56cbad01e4",
"legal_name": "Fundación Universitaria CEIPA",
"tax_id": "890910961-7",
"country": "Colombia",
"legal_address": "Calle 77 Sur #No 40 -165, 055413 SABANETA, Antioquia, Colombia",
"email": "maria.perez@ceipa.edu.co",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "6878",
"odoo_partner_id": 6878
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:58.109Z","Cliente actualizado exitosamente - ID: 6c4ccb7b-5b09-49ac-aedd-10f8ccd78568",14845]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Procesando Partner #14844 | Odoo ID: 526
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:43 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=526, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ email = "pur@udd.cl"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ tax_id = "71644300-0"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_name = "UNIVERSIDAD DEL DESARROLLO"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ client_number = 526
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_address = "Avenida Plaza 680, Santiago, Metropolitana, Chile"
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"odoo_partner_id": 526,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "pur@udd.cl",
"phone": false,
"tax_id": "71644300-0",
"country": "Chile",
"legal_name": "UNIVERSIDAD DEL DESARROLLO",
"client_number": 526,
"legal_address": "Avenida Plaza 680, Santiago, Metropolitana, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 71644300-0 y Odoo ID: 526
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["71644300-0","f6e3cb81-8b4a-451e-8402-573e47688d45",526]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=34ab2276-f40d-4796-92b7-a9677b9fd701
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [526,"f6e3cb81-8b4a-451e-8402-573e47688d45","pur@udd.cl",false,"71644300-0","Chile","UNIVERSIDAD DEL DESARROLLO",526,"Avenida Plaza 680, Santiago, Metropolitana, Chile","34ab2276-f40d-4796-92b7-a9677b9fd701"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["34ab2276-f40d-4796-92b7-a9677b9fd701"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"id": "34ab2276-f40d-4796-92b7-a9677b9fd701",
"client_id": "f41ebddc-3fba-400a-a47d-f6c4ac8b9e9e",
"legal_name": "UNIVERSIDAD DEL DESARROLLO",
"tax_id": "71644300-0",
"country": "Chile",
"legal_address": "Avenida Plaza 680, Santiago, Metropolitana, Chile",
"email": "pur@udd.cl",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "526",
"odoo_partner_id": 526
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:58.351Z","Cliente actualizado exitosamente - ID: 34ab2276-f40d-4796-92b7-a9677b9fd701",14844]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Procesando Partner #14843 | Odoo ID: 6887
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:43 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=6887, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ email = "facturacion.electronica@unisabana.edu.co"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ tax_id = "860075558-1"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ country = "Colombia"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_name = "Universidad de La Sabana"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ client_number = 6887
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_address = "KM 7 AUTP Norte, 111021 Bogotá D.C., Bogotá, Colombia"
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"odoo_partner_id": 6887,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "facturacion.electronica@unisabana.edu.co",
"phone": false,
"tax_id": "860075558-1",
"country": "Colombia",
"legal_name": "Universidad de La Sabana",
"client_number": 6887,
"legal_address": "KM 7 AUTP Norte, 111021 Bogotá D.C., Bogotá, Colombia"
}
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 860075558-1 y Odoo ID: 6887
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["860075558-1","f6e3cb81-8b4a-451e-8402-573e47688d45",6887]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=00f4441c-72f4-44c5-9d83-c0f64809c13c
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [6887,"f6e3cb81-8b4a-451e-8402-573e47688d45","facturacion.electronica@unisabana.edu.co",false,"860075558-1","Colombia","Universidad de La Sabana",6887,"KM 7 AUTP Norte, 111021 Bogotá D.C., Bogotá, Colombia","00f4441c-72f4-44c5-9d83-c0f64809c13c"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["00f4441c-72f4-44c5-9d83-c0f64809c13c"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"id": "00f4441c-72f4-44c5-9d83-c0f64809c13c",
"client_id": "3e798349-2350-4496-8f68-367a59768d1d",
"legal_name": "Universidad de La Sabana",
"tax_id": "860075558-1",
"country": "Colombia",
"legal_address": "KM 7 AUTP Norte, 111021 Bogotá D.C., Bogotá, Colombia",
"email": "facturacion.electronica@unisabana.edu.co",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "6887",
"odoo_partner_id": 6887
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:58.591Z","Cliente actualizado exitosamente - ID: 00f4441c-72f4-44c5-9d83-c0f64809c13c",14843]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Procesando Partner #14842 | Odoo ID: 475
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:42 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=475, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ tax_id = "5555555-5"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ country = "Peru"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_name = "Universidad Peruana de Ciencias Aplicadas SAC"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ client_number = 475
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_address = "Alonso de Molina 1611, Lima, Perú"
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"odoo_partner_id": 475,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "5555555-5",
"country": "Peru",
"legal_name": "Universidad Peruana de Ciencias Aplicadas SAC",
"client_number": 475,
"legal_address": "Alonso de Molina 1611, Lima, Perú"
}
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 5555555-5 y Odoo ID: 475
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45",475]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ Cliente manual encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0, se vinculará con Odoo ID 475
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [475,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Peru","Universidad Peruana de Ciencias Aplicadas SAC",475,"Alonso de Molina 1611, Lima, Perú","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
query failed: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [475,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Peru","Universidad Peruana de Ciencias Aplicadas SAC",475,"Alonso de Molina 1611, Lima, Perú","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
error: error: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] ❌ ERROR EN BD AL ACTUALIZAR:
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Código: 23505
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Detalle: Key (odoo_partner_id, holding_id)=(475, f6e3cb81-8b4a-451e-8402-573e47688d45) already exists.
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Stack trace:
QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService]
❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] ❌ ERROR PROCESANDO PARTNER 475
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Tipo: QueryFailedError
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Stack completo:
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] Datos del partner:
[Nest] 94839 - 02/02/2026, 10:38:58 ERROR [PartnersProcessorService] {
"id": 14842,
"odoo_id": 475,
"raw_data": {
"id": 475,
"ref": "CE0006",
"vat": "5555555-5",
"zip": false,
"city": "Lima",
"name": "Universidad Peruana de Ciencias Aplicadas SAC",
"email": false,
"phone": false,
"title": false,
"active": true,
"mobile": false,
"street": "Alonso de Molina 1611",
"street2": "Santiago de Surco,",
"website": false,
"function": false,
"state_id": false,
"write_uid": [
8,
"Miguel T"
],
"country_id": [
173,
"Peru"
],
"create_uid": [
2,
"SAPIRA (externo)"
],
"is_company": true,
"write_date": "2023-09-12 18:30:56",
"category_id": [
1,
3
],
"create_date": "2022-10-17 14:56:23",
"industry_id": false,
"company_type": "company",
"display_name": "Universidad Peruana de Ciencias Aplicadas SAC",
"phone_sanitized": false,
"email_normalized": false,
"commercial_partner_id": [
475,
"Universidad Peruana de Ciencias Aplicadas SAC"
],
"contact_address_complete": "Alonso de Molina 1611, Lima, Perú",
"l10n_cl_activity_description": "UNIVERSIDAD"
},
"processed_at": null,
"sync_batch_id": "452a5b61-a623-4f1c-b9cd-e16e19ee38fd",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"created_at": "2026-02-02T16:36:42.475Z",
"updated_at": "2026-02-02T16:36:42.475Z",
"processing_status": "update",
"integration_batch_id": null,
"last_integrated_at": null,
"integration_notes": "Cliente existente encontrado por Odoo ID - marcado para actualización"
}
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Procesando Partner #14841 | Odoo ID: 522
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:41 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=522, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ email = "facturas@udla.cl"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ tax_id = "71540800-7"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_name = "UNIVERSIDAD DE LAS AMERICAS"
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ client_number = 522
[Nest] 94839 - 02/02/2026, 10:38:58 DEBUG [PartnersProcessorService] ✓ legal_address = "Manuel Montt 948, Santiago, Metropolitana, Chile"
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] {
"odoo_partner_id": 522,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "facturas@udla.cl",
"phone": false,
"tax_id": "71540800-7",
"country": "Chile",
"legal_name": "UNIVERSIDAD DE LAS AMERICAS",
"client_number": 522,
"legal_address": "Manuel Montt 948, Santiago, Metropolitana, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 71540800-7 y Odoo ID: 522
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["71540800-7","f6e3cb81-8b4a-451e-8402-573e47688d45",522]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["71540800-7","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:58 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [522,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=2c39745a-64a2-4e34-9d13-5950fe0d1e02
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=2c39745a-64a2-4e34-9d13-5950fe0d1e02
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [522,"f6e3cb81-8b4a-451e-8402-573e47688d45","facturas@udla.cl",false,"71540800-7","Chile","UNIVERSIDAD DE LAS AMERICAS",522,"Manuel Montt 948, Santiago, Metropolitana, Chile","2c39745a-64a2-4e34-9d13-5950fe0d1e02"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["2c39745a-64a2-4e34-9d13-5950fe0d1e02"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"id": "2c39745a-64a2-4e34-9d13-5950fe0d1e02",
"client_id": null,
"legal_name": "UNIVERSIDAD DE LAS AMERICAS",
"tax_id": "71540800-7",
"country": "Chile",
"legal_address": "Manuel Montt 948, Santiago, Metropolitana, Chile",
"email": "facturas@udla.cl",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "522",
"odoo_partner_id": 522
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:59.128Z","Cliente actualizado exitosamente - ID: 2c39745a-64a2-4e34-9d13-5950fe0d1e02",14841]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Procesando Partner #14840 | Odoo ID: 537
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:41 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=537, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ email = "pucrecepcion@custodium.com"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ tax_id = "81698900-0"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ country = "Chile"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_name = "PONTIFICIA UNIVERSIDAD CATOLICA DE CHILE"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ client_number = 537
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_address = "AV LIBERTADOR BERNARDO O´HIGGINS 340, SANTIAGO, Chile"
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"odoo_partner_id": 537,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": "pucrecepcion@custodium.com",
"phone": false,
"tax_id": "81698900-0",
"country": "Chile",
"legal_name": "PONTIFICIA UNIVERSIDAD CATOLICA DE CHILE",
"client_number": 537,
"legal_address": "AV LIBERTADOR BERNARDO O´HIGGINS 340, SANTIAGO, Chile"
}
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 81698900-0 y Odoo ID: 537
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["81698900-0","f6e3cb81-8b4a-451e-8402-573e47688d45",537]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["81698900-0","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Buscando por Odoo ID + Holding ID...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."odoo_partner_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: [537,"f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente encontrado por Odoo ID: ID=1944a5a7-d973-496a-947e-9991eaa267d4
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=1944a5a7-d973-496a-947e-9991eaa267d4
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [537,"f6e3cb81-8b4a-451e-8402-573e47688d45","pucrecepcion@custodium.com",false,"81698900-0","Chile","PONTIFICIA UNIVERSIDAD CATOLICA DE CHILE",537,"AV LIBERTADOR BERNARDO O´HIGGINS 340, SANTIAGO, Chile","1944a5a7-d973-496a-947e-9991eaa267d4"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["1944a5a7-d973-496a-947e-9991eaa267d4"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"id": "1944a5a7-d973-496a-947e-9991eaa267d4",
"client_id": null,
"legal_name": "PONTIFICIA UNIVERSIDAD CATOLICA DE CHILE",
"tax_id": "81698900-0",
"country": "Chile",
"legal_address": "AV LIBERTADOR BERNARDO O´HIGGINS 340, SANTIAGO, Chile",
"email": "pucrecepcion@custodium.com",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "537",
"odoo_partner_id": 537
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:38:59.487Z","Cliente actualizado exitosamente - ID: 1944a5a7-d973-496a-947e-9991eaa267d4",14840]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Procesando Partner #14839 | Odoo ID: 497
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:40 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=497, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ tax_id = "5555555-5"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ country = "Colombia"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_name = "UNIVERSIDAD COOPERATIVA DE COLOMBIA"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ client_number = 497
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_address = "Carrera 42 No 49-95 Bloque 8, Medellin, Colombia"
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"odoo_partner_id": 497,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "5555555-5",
"country": "Colombia",
"legal_name": "UNIVERSIDAD COOPERATIVA DE COLOMBIA",
"client_number": 497,
"legal_address": "Carrera 42 No 49-95 Bloque 8, Medellin, Colombia"
}
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 5555555-5 y Odoo ID: 497
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45",497]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente manual encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0, se vinculará con Odoo ID 497
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [497,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Colombia","UNIVERSIDAD COOPERATIVA DE COLOMBIA",497,"Carrera 42 No 49-95 Bloque 8, Medellin, Colombia","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
query failed: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [497,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Colombia","UNIVERSIDAD COOPERATIVA DE COLOMBIA",497,"Carrera 42 No 49-95 Bloque 8, Medellin, Colombia","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
error: error: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] ❌ ERROR EN BD AL ACTUALIZAR:
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Código: 23505
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Detalle: Key (odoo_partner_id, holding_id)=(497, f6e3cb81-8b4a-451e-8402-573e47688d45) already exists.
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Stack trace:
QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService]
❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] ❌ ERROR PROCESANDO PARTNER 497
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Tipo: QueryFailedError
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Stack completo:
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Datos del partner:
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] {
"id": 14839,
"odoo_id": 497,
"raw_data": {
"id": 497,
"ref": "CE0028",
"vat": "5555555-5",
"zip": false,
"city": "Medellin",
"name": "UNIVERSIDAD COOPERATIVA DE COLOMBIA",
"email": false,
"phone": false,
"title": false,
"active": true,
"mobile": false,
"street": "Carrera 42 No 49-95 Bloque 8",
"street2": false,
"website": false,
"function": false,
"state_id": false,
"write_uid": [
1,
"OdooBot"
],
"country_id": [
49,
"Colombia"
],
"create_uid": [
2,
"SAPIRA (externo)"
],
"is_company": true,
"write_date": "2023-07-04 19:23:13",
"category_id": [
1,
3
],
"create_date": "2022-10-17 14:56:23",
"industry_id": false,
"company_type": "company",
"display_name": "UNIVERSIDAD COOPERATIVA DE COLOMBIA",
"phone_sanitized": false,
"email_normalized": false,
"commercial_partner_id": [
497,
"UNIVERSIDAD COOPERATIVA DE COLOMBIA"
],
"contact_address_complete": "Carrera 42 No 49-95 Bloque 8, Medellin, Colombia",
"l10n_cl_activity_description": "UNIVERSIDAD"
},
"processed_at": null,
"sync_batch_id": "452a5b61-a623-4f1c-b9cd-e16e19ee38fd",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"created_at": "2026-02-02T16:36:40.417Z",
"updated_at": "2026-02-02T16:36:40.417Z",
"processing_status": "update",
"integration_batch_id": null,
"last_integrated_at": null,
"integration_notes": "Cliente existente encontrado por Odoo ID - marcado para actualización"
}
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Procesando Partner #14838 | Odoo ID: 503
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:39 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=503, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ tax_id = "5555555-5"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ country = "Spain"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_name = "TELEFÓNICA EDUCACIÓN DIGITAL"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ client_number = 503
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_address = "Ronda de la Comunicación s/n Distrito C - Edificio Oeste 1, Planta 7, Madrid, España"
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"odoo_partner_id": 503,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "5555555-5",
"country": "Spain",
"legal_name": "TELEFÓNICA EDUCACIÓN DIGITAL",
"client_number": 503,
"legal_address": "Ronda de la Comunicación s/n Distrito C - Edificio Oeste 1, Planta 7, Madrid, España"
}
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 5555555-5 y Odoo ID: 503
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45",503]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente manual encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0, se vinculará con Odoo ID 503
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [503,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Spain","TELEFÓNICA EDUCACIÓN DIGITAL",503,"Ronda de la Comunicación s/n Distrito C - Edificio Oeste 1, Planta 7, Madrid, España","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
query failed: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [503,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Spain","TELEFÓNICA EDUCACIÓN DIGITAL",503,"Ronda de la Comunicación s/n Distrito C - Edificio Oeste 1, Planta 7, Madrid, España","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
error: error: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] ❌ ERROR EN BD AL ACTUALIZAR:
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Código: 23505
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Detalle: Key (odoo_partner_id, holding_id)=(503, f6e3cb81-8b4a-451e-8402-573e47688d45) already exists.
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Stack trace:
QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService]
❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] ❌ ERROR PROCESANDO PARTNER 503
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Tipo: QueryFailedError
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Stack completo:
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] Datos del partner:
[Nest] 94839 - 02/02/2026, 10:38:59 ERROR [PartnersProcessorService] {
"id": 14838,
"odoo_id": 503,
"raw_data": {
"id": 503,
"ref": "CE0034",
"vat": "5555555-5",
"zip": false,
"city": "Madrid",
"name": "TELEFÓNICA EDUCACIÓN DIGITAL",
"email": false,
"phone": false,
"title": false,
"active": true,
"mobile": false,
"street": "Ronda de la Comunicación s/n Distrito C - Edificio Oeste 1, Planta 7",
"street2": false,
"website": false,
"function": false,
"state_id": false,
"write_uid": [
8,
"Miguel T"
],
"country_id": [
68,
"Spain"
],
"create_uid": [
2,
"SAPIRA (externo)"
],
"is_company": true,
"write_date": "2024-06-25 16:06:10",
"category_id": [
1,
3
],
"create_date": "2022-10-17 14:56:23",
"industry_id": false,
"company_type": "company",
"display_name": "TELEFÓNICA EDUCACIÓN DIGITAL",
"phone_sanitized": false,
"email_normalized": false,
"commercial_partner_id": [
503,
"TELEFÓNICA EDUCACIÓN DIGITAL"
],
"contact_address_complete": "Ronda de la Comunicación s/n Distrito C - Edificio Oeste 1, Planta 7, Madrid, España",
"l10n_cl_activity_description": "UNIVERSIDAD"
},
"processed_at": null,
"sync_batch_id": "452a5b61-a623-4f1c-b9cd-e16e19ee38fd",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"created_at": "2026-02-02T16:36:39.723Z",
"updated_at": "2026-02-02T16:36:39.723Z",
"processing_status": "update",
"integration_batch_id": null,
"last_integrated_at": null,
"integration_notes": "Cliente existente encontrado por Odoo ID - marcado para actualización"
}
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Procesando Partner #14837 | Odoo ID: 7024
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:38 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=7024, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ tax_id = 20172627421
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ country = "Peru"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_name = "Universidad de Piura"
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ client_number = 7024
[Nest] 94839 - 02/02/2026, 10:38:59 DEBUG [PartnersProcessorService] ✓ legal_address = "Piura, Perú"
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] {
"odoo_partner_id": 7024,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": 20172627421,
"country": "Peru",
"legal_name": "Universidad de Piura",
"client_number": 7024,
"legal_address": "Piura, Perú"
}
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 20172627421 y Odoo ID: 7024
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["20172627421","f6e3cb81-8b4a-451e-8402-573e47688d45",7024]
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=72b336b9-c03a-4a03-bff1-382511171551
[Nest] 94839 - 02/02/2026, 10:38:59 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [7024,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,20172627421,"Peru","Universidad de Piura",7024,"Piura, Perú","72b336b9-c03a-4a03-bff1-382511171551"]
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [AgentsScheduler] Checking for scheduled agents to execute...
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["72b336b9-c03a-4a03-bff1-382511171551"]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"id": "72b336b9-c03a-4a03-bff1-382511171551",
"client_id": "8e1f2459-01e3-456e-83f2-955b08d9c870",
"legal_name": "Universidad de Piura",
"tax_id": "20172627421",
"country": "Peru",
"legal_address": "Piura, Perú",
"email": "false",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "7024",
"odoo_partner_id": 7024
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:39:00.078Z","Cliente actualizado exitosamente - ID: 72b336b9-c03a-4a03-bff1-382511171551",14837]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Procesando Partner #14836 | Odoo ID: 7096
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:38 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=7096, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ tax_id = 20107798049
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ country = "Peru"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_name = "Universidad de Lima"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ client_number = 7096
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_address = "Avenida Javier Prado Este 33, 15023 Lima, Perú"
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"odoo_partner_id": 7096,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": 20107798049,
"country": "Peru",
"legal_name": "Universidad de Lima",
"client_number": 7096,
"legal_address": "Avenida Javier Prado Este 33, 15023 Lima, Perú"
}
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 20107798049 y Odoo ID: 7096
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["20107798049","f6e3cb81-8b4a-451e-8402-573e47688d45",7096]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=44cc7931-ce28-4de2-96e3-6549d1835c84
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [7096,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,20107798049,"Peru","Universidad de Lima",7096,"Avenida Javier Prado Este 33, 15023 Lima, Perú","44cc7931-ce28-4de2-96e3-6549d1835c84"]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ ÉXITO: Cliente actualizado correctamente
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Respuesta de BD - Filas afectadas: 1
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"generatedMaps": [],
"raw": [],
"affected": 1
}
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."id" = $1)) LIMIT 1 -- PARAMETERS: ["44cc7931-ce28-4de2-96e3-6549d1835c84"]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📋 Datos actualizados:
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"id": "44cc7931-ce28-4de2-96e3-6549d1835c84",
"client_id": "9fc68dc3-51aa-4055-89d0-9d9b04497e27",
"legal_name": "Universidad de Lima",
"tax_id": "20107798049",
"country": "Peru",
"legal_address": "Avenida Javier Prado Este 33, 15023 Lima, Perú",
"email": "false",
"phone": "false",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"economic_activity": null,
"client_number": "7096",
"odoo_partner_id": 7096
}
query: UPDATE "odoo_partners_stg" SET "processing_status" = $1, "last_integrated_at" = $2, "integration_notes" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" IN ($4) -- PARAMETERS: ["processed","2026-02-02T13:39:00.320Z","Cliente actualizado exitosamente - ID: 44cc7931-ce28-4de2-96e3-6549d1835c84",14836]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Estado actualizado en staging: processed
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Procesando Partner #14835 | Odoo ID: 7052
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Estado: processed
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:37 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=7052, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ tax_id = 20545990998
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ country = "Peru"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_name = "Universidad de Ingeniería y Tecnología"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ client_number = 7052
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_address = "Jr. Medrano Silva 165 - Barranco, Lima, Perú"
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"odoo_partner_id": 7052,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": 20545990998,
"country": "Peru",
"legal_name": "Universidad de Ingeniería y Tecnología",
"client_number": 7052,
"legal_address": "Jr. Medrano Silva 165 - Barranco, Lima, Perú"
}
[Nest] 94839 - 02/02/2026, 10:39:00 WARN [PartnersProcessorService] ⚠️ Partner 7052 tiene estado no procesable: processed
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Procesando Partner #14834 | Odoo ID: 501
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:37 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=501, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ tax_id = "5555555-5"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ country = "Colombia"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_name = "U-PLANNER S.A.S."
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ client_number = 501
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_address = "Calle 93 A Nro 13 24, Piso 5, Edificio QBO, Bogotá, Colombia"
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"odoo_partner_id": 501,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "5555555-5",
"country": "Colombia",
"legal_name": "U-PLANNER S.A.S.",
"client_number": 501,
"legal_address": "Calle 93 A Nro 13 24, Piso 5, Edificio QBO, Bogotá, Colombia"
}
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 5555555-5 y Odoo ID: 501
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45",501]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PostgreSQLDatabaseProvider] 🟢 Nueva conexión PostgreSQL establecida
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PostgreSQLDatabaseProvider] [object Object]
query:
SELECT
id,
type,
schedule,
holding_id,
auto_execute,
require_approval
FROM ai_agents
WHERE is_enabled = true
AND auto_execute = true
AND schedule IS NOT NULL

[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [AgentsScheduler] No scheduled agents found
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Cliente manual encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0, se vinculará con Odoo ID 501
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [501,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Colombia","U-PLANNER S.A.S.",501,"Calle 93 A Nro 13 24, Piso 5, Edificio QBO, Bogotá, Colombia","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
query failed: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [501,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Colombia","U-PLANNER S.A.S.",501,"Calle 93 A Nro 13 24, Piso 5, Edificio QBO, Bogotá, Colombia","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
error: error: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌ ERROR EN BD AL ACTUALIZAR:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Código: 23505
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Detalle: Key (odoo_partner_id, holding_id)=(501, f6e3cb81-8b4a-451e-8402-573e47688d45) already exists.
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Stack trace:
QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService]
❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌ ERROR PROCESANDO PARTNER 501
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Tipo: QueryFailedError
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Stack completo:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Datos del partner:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] {
"id": 14834,
"odoo_id": 501,
"raw_data": {
"id": 501,
"ref": "CE0032",
"vat": "5555555-5",
"zip": false,
"city": "Bogotá",
"name": "U-PLANNER S.A.S.",
"email": false,
"phone": false,
"title": false,
"active": true,
"mobile": false,
"street": "Calle 93 A Nro 13 24, Piso 5, Edificio QBO",
"street2": false,
"website": false,
"function": false,
"state_id": false,
"write_uid": [
1,
"OdooBot"
],
"country_id": [
49,
"Colombia"
],
"create_uid": [
2,
"SAPIRA (externo)"
],
"is_company": true,
"write_date": "2023-07-04 19:23:13",
"category_id": [
1,
3
],
"create_date": "2022-10-17 14:56:23",
"industry_id": false,
"company_type": "company",
"display_name": "U-PLANNER S.A.S.",
"phone_sanitized": false,
"email_normalized": false,
"commercial_partner_id": [
501,
"U-PLANNER S.A.S."
],
"contact_address_complete": "Calle 93 A Nro 13 24, Piso 5, Edificio QBO, Bogotá, Colombia",
"l10n_cl_activity_description": "UNIVERSIDAD"
},
"processed_at": null,
"sync_batch_id": "452a5b61-a623-4f1c-b9cd-e16e19ee38fd",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"created_at": "2026-02-02T16:36:37.322Z",
"updated_at": "2026-02-02T16:36:37.322Z",
"processing_status": "update",
"integration_batch_id": null,
"last_integrated_at": null,
"integration_notes": "Cliente existente encontrado por Odoo ID - marcado para actualización"
}
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Procesando Partner #14833 | Odoo ID: 482
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:36 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=482, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ tax_id = "5555555-5"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ country = "Peru"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_name = "U-PLANNER PERÚ SAC"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ client_number = 482
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_address = "AV. ENRIQUE CANAVAL Y MOREYRA 480 INT. 10B URB. LIMATAMBO, LIMA, Peru"
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"odoo_partner_id": 482,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "5555555-5",
"country": "Peru",
"legal_name": "U-PLANNER PERÚ SAC",
"client_number": 482,
"legal_address": "AV. ENRIQUE CANAVAL Y MOREYRA 480 INT. 10B URB. LIMATAMBO, LIMA, Peru"
}
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 5555555-5 y Odoo ID: 482
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45",482]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Cliente manual encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0, se vinculará con Odoo ID 482
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [482,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Peru","U-PLANNER PERÚ SAC",482,"AV. ENRIQUE CANAVAL Y MOREYRA 480 INT. 10B URB. LIMATAMBO, LIMA, Peru","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
query failed: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [482,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Peru","U-PLANNER PERÚ SAC",482,"AV. ENRIQUE CANAVAL Y MOREYRA 480 INT. 10B URB. LIMATAMBO, LIMA, Peru","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
error: error: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌ ERROR EN BD AL ACTUALIZAR:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Código: 23505
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Detalle: Key (odoo_partner_id, holding_id)=(482, f6e3cb81-8b4a-451e-8402-573e47688d45) already exists.
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Stack trace:
QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService]
❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌ ERROR PROCESANDO PARTNER 482
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Tipo: QueryFailedError
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Stack completo:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Datos del partner:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] {
"id": 14833,
"odoo_id": 482,
"raw_data": {
"id": 482,
"ref": "CE0013",
"vat": "5555555-5",
"zip": false,
"city": "LIMA",
"name": "U-PLANNER PERÚ SAC",
"email": false,
"phone": false,
"title": false,
"active": true,
"mobile": false,
"street": "AV. ENRIQUE CANAVAL Y MOREYRA 480 INT. 10B URB. LIMATAMBO",
"street2": false,
"website": false,
"function": false,
"state_id": false,
"write_uid": [
1,
"OdooBot"
],
"country_id": [
173,
"Peru"
],
"create_uid": [
2,
"SAPIRA (externo)"
],
"is_company": true,
"write_date": "2023-07-04 19:23:13",
"category_id": [
1,
3,
4
],
"create_date": "2022-10-17 14:56:23",
"industry_id": false,
"company_type": "company",
"display_name": "U-PLANNER PERÚ SAC",
"phone_sanitized": false,
"email_normalized": false,
"commercial_partner_id": [
482,
"U-PLANNER PERÚ SAC"
],
"contact_address_complete": "AV. ENRIQUE CANAVAL Y MOREYRA 480 INT. 10B URB. LIMATAMBO, LIMA, Peru",
"l10n_cl_activity_description": "UNIVERSIDAD"
},
"processed_at": null,
"sync_batch_id": "452a5b61-a623-4f1c-b9cd-e16e19ee38fd",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"created_at": "2026-02-02T16:36:36.626Z",
"updated_at": "2026-02-02T16:36:36.626Z",
"processing_status": "update",
"integration_batch_id": null,
"last_integrated_at": null,
"integration_notes": "Cliente existente encontrado por Odoo ID - marcado para actualización"
}
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]

---

[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Procesando Partner #14832 | Odoo ID: 514
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Estado: update
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📅 Creado: Mon Feb 02 2026 13:36:35 GMT-0300 (hora de verano de Chile)
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] --------------------------------------------------------------------------------
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔧 Construyendo objeto mapeado...
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📝 Datos base: odoo_partner_id=514, holding_id=f6e3cb81-8b4a-451e-8402-573e47688d45
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ email = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ phone = false
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ tax_id = "5555555-5"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ country = "Mexico"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_name = "U-PLANNER S.A DE C.V"
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ client_number = 514
[Nest] 94839 - 02/02/2026, 10:39:00 DEBUG [PartnersProcessorService] ✓ legal_address = "RIO NAZAS 96, Ciudad de México, Mexico"
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
📦 Datos mapeados finales:
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] {
"odoo_partner_id": 514,
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"email": false,
"phone": false,
"tax_id": "5555555-5",
"country": "Mexico",
"legal_name": "U-PLANNER S.A DE C.V",
"client_number": 514,
"legal_address": "RIO NAZAS 96, Ciudad de México, Mexico"
}
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
🔄 OPERACIÓN: UPDATE
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 Buscando cliente existente con VAT: 5555555-5 y Odoo ID: 514
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2) AND ("ClientEntity"."odoo_partner_id" = $3)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45",514]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...
query: SELECT "ClientEntity"."id" AS "ClientEntity_id", "ClientEntity"."client_id" AS "ClientEntity_client_id", "ClientEntity"."legal_name" AS "ClientEntity_legal_name", "ClientEntity"."tax_id" AS "ClientEntity_tax_id", "ClientEntity"."country" AS "ClientEntity_country", "ClientEntity"."legal_address" AS "ClientEntity_legal_address", "ClientEntity"."email" AS "ClientEntity_email", "ClientEntity"."phone" AS "ClientEntity_phone", "ClientEntity"."holding_id" AS "ClientEntity_holding_id", "ClientEntity"."economic_activity" AS "ClientEntity_economic_activity", "ClientEntity"."client_number" AS "ClientEntity_client_number", "ClientEntity"."odoo_partner_id" AS "ClientEntity_odoo_partner_id" FROM "client_entities" "ClientEntity" WHERE (("ClientEntity"."tax_id" = $1) AND ("ClientEntity"."holding_id" = $2)) LIMIT 1 -- PARAMETERS: ["5555555-5","f6e3cb81-8b4a-451e-8402-573e47688d45"]
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Cliente manual encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0, se vinculará con Odoo ID 514
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Cliente encontrado: ID=f7f70b89-42fd-4b1e-b84c-639dca88b9b0
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 💾 Actualizando cliente en la base de datos...
query: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [514,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Mexico","U-PLANNER S.A DE C.V",514,"RIO NAZAS 96, Ciudad de México, Mexico","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
query failed: UPDATE "client_entities" SET "odoo_partner_id" = $1, "holding_id" = $2, "email" = $3, "phone" = $4, "tax_id" = $5, "country" = $6, "legal_name" = $7, "client_number" = $8, "legal_address" = $9 WHERE "id" IN ($10) -- PARAMETERS: [514,"f6e3cb81-8b4a-451e-8402-573e47688d45",false,false,"5555555-5","Mexico","U-PLANNER S.A DE C.V",514,"RIO NAZAS 96, Ciudad de México, Mexico","f7f70b89-42fd-4b1e-b84c-639dca88b9b0"]
error: error: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌ ERROR EN BD AL ACTUALIZAR:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Código: 23505
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Detalle: Key (odoo_partner_id, holding_id)=(514, f6e3cb81-8b4a-451e-8402-573e47688d45) already exists.
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Stack trace:
QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService]
❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌ ERROR PROCESANDO PARTNER 514
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Mensaje: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Tipo: QueryFailedError
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Stack completo:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] QueryFailedError: duplicate key value violates unique constraint "idx_client_entities_odoo_partner_holding"
at PostgresQueryRunner.query (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/driver/src/driver/postgres/PostgresQueryRunner.ts:325:19)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async UpdateQueryBuilder.execute (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/node_modules/typeorm/query-builder/src/query-builder/UpdateQueryBuilder.ts:145:33)
at async PartnersProcessorService.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/services/partners-processor.service.ts:261:29)
at async PartnersController.processPartners (/Users/leonmontero/apps/nodeApps/sapira/api-sapira-ai/src/modules/odoo/partners.controller.ts:35:10)
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] Datos del partner:
[Nest] 94839 - 02/02/2026, 10:39:00 ERROR [PartnersProcessorService] {
"id": 14832,
"odoo_id": 514,
"raw_data": {
"id": 514,
"ref": "CE0045",
"vat": "5555555-5",
"zip": false,
"city": "Ciudad de México",
"name": "U-PLANNER S.A DE C.V",
"email": false,
"phone": false,
"title": false,
"active": true,
"mobile": false,
"street": "RIO NAZAS 96",
"street2": false,
"website": false,
"function": false,
"state_id": false,
"write_uid": [
1,
"OdooBot"
],
"country_id": [
156,
"Mexico"
],
"create_uid": [
2,
"SAPIRA (externo)"
],
"is_company": true,
"write_date": "2023-07-04 19:23:13",
"category_id": [
1,
3
],
"create_date": "2022-10-17 14:56:23",
"industry_id": false,
"company_type": "company",
"display_name": "U-PLANNER S.A DE C.V",
"phone_sanitized": false,
"email_normalized": false,
"commercial_partner_id": [
514,
"U-PLANNER S.A DE C.V"
],
"contact_address_complete": "RIO NAZAS 96, Ciudad de México, Mexico",
"l10n_cl_activity_description": "UNIVERSIDAD"
},
"processed_at": null,
"sync_batch_id": "452a5b61-a623-4f1c-b9cd-e16e19ee38fd",
"holding_id": "f6e3cb81-8b4a-451e-8402-573e47688d45",
"created_at": "2026-02-02T16:36:35.928Z",
"updated_at": "2026-02-02T16:36:35.928Z",
"processing_status": "update",
"integration_batch_id": null,
"last_integrated_at": null,
"integration_notes": "Cliente existente encontrado por Odoo ID - marcado para actualización"
}
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService]
================================================================================
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ PROCESAMIENTO COMPLETADO
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ================================================================================
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📊 Total procesados: 21
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ✅ Exitosos: 14
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ❌ Errores: 6
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] 📈 Tasa de éxito: 66.67%
[Nest] 94839 - 02/02/2026, 10:39:00 LOG [PartnersProcessorService] ================================================================================

[Nest] 94839 - 02/02/2026, 10:39:00 LOG [AppLoggerService] POST /odoo/partners/process completed with status 201
