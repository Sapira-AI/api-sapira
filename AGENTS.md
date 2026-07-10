# Sapira API Guide

## Reglas base

- Responde y documenta en espanol.
- Limita los cambios a lo solicitado y no elimines codigo existente sin instruccion explicita.
- Reutiliza modulos, servicios, providers y patrones existentes antes de crear nuevos.
- Revisa `package.json` antes de proponer dependencias, scripts o comandos.

## Stack

- NestJS + TypeScript.
- Yarn 4 definido por el proyecto.
- Arquitectura modular con controllers, services y providers.

## Convenciones

- Mantiene la estructura usual de modulo: `dtos`, `interfaces`, `schemas`, `helpers`, `controller`, `module`, `provider`, `service`.
- Crea controladores y providers siguiendo los modulos ya existentes.
- Evita refactors o simplificaciones no pedidas.
- No hagas commits ni cambios destructivos de git sin instruccion explicita.
- Toda funcionalidad nueva o modificada debe evaluar si cambia comportamiento, flujos, contratos, integraciones, payloads, validaciones o configuracion relevante; si aplica, actualizar documentacion es obligatorio.
- Prioriza documentar en la ubicacion mas cercana del modulo afectado: `src/modules/<modulo>/docs/` si ya existe, o `api-sapira-ai/docs/` si la documentacion es transversal o aun no hay docs del modulo.
- Toda funcionalidad nueva o modificada en backend debe incluir tests unitarios nuevos o actualizados.
- Usa Jest para pruebas unitarias y manten las specs dentro de `src/` con sufijo `.spec.ts`, idealmente cerca del modulo afectado.
