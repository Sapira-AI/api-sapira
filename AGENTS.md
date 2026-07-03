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
