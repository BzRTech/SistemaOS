# SistemaOS 2.0

Reescrita do Sistema de Gestão de Ordens de Serviço (Admin → Secretaria → Empresa →
Equipe de Campo), **web responsivo** com visão mobile dedicada para as equipes.

Motivação da reescrita (dores da v1):
- **GPS/fotos no iOS** instáveis → captura isolada + PWA/offline (fases seguintes).
- **Bugs de permissão/fluxo** → entidades de 1ª classe + escopo por linha centralizado + máquina de estados no servidor.
- **Código difícil de manter** → monorepo TypeScript modular, migrations, testes.

O sistema legado está preservado em [`legacy/`](./legacy) e serve de fonte para a migração de dados.

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node + TypeScript + **NestJS** |
| ORM/DB | **Prisma** + PostgreSQL (Neon em produção) |
| Frontend | React + TypeScript + Vite (fase seguinte) |
| Fotos | Object storage **AWS S3** (MinIO em dev) |
| Auth | JWT + argon2 |
| Testes | Vitest |

## Estrutura

```
apps/api        Backend NestJS + Prisma
apps/web        Frontend React (a implementar)
packages/shared Enums, máquina de estados da OS e contratos (zod) — fonte única
legacy/         App v1 preservado (Express + JS puro)
```

## Desenvolvimento local

Pré-requisitos: Node 20+, pnpm 10+, Docker (ou um PostgreSQL local).

```bash
pnpm install
cp .env.example .env            # ajuste DATABASE_URL se necessário
docker compose up -d postgres   # sobe Postgres (e MinIO p/ storage)

pnpm prisma:migrate             # cria/aplica migrations
pnpm prisma:seed                # admin inicial + SLA + categorias
pnpm dev:api                    # API em http://localhost:3000/api
```

Admin inicial (seed): `admin@sistemaos.local` / `admin123` (configurável em `.env`).

### Verificação rápida

```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@sistemaos.local","senha":"admin123"}'
```

## Testes

```bash
pnpm test   # inclui isolamento entre empresas/equipes e a máquina de estados
```

## Status de implementação (roteiro em fases)

- [x] **Fase 0** — Fundação: monorepo, Prisma schema completo, docker-compose, seed, CI-ready.
- [x] **Fase 1** — Auth & RBAC: login/JWT, guard de perfil, escopo organizacional por linha, testes de autorização.
- [ ] Fase 2 — CRUD de Secretarias, Empresas, Equipes, Usuários.
- [ ] Fase 3 — OS + workflow (máquina de estados já definida em `packages/shared`).
- [ ] Fase 4 — Campo (mobile web): captura foto+GPS, check-in/out.
- [ ] Fase 5 — Storage S3 + thumbnails.
- [ ] Fase 6 — Mapa (Leaflet + clustering) & Dashboard + SLA.
- [ ] Fase 7 — PWA/Offline + sync (idempotência por `client_uuid`).
- [ ] Fase 8 — Auditoria & Notificações.
- [ ] Fase 9 — Relatórios (CSV/Excel/PDF) & migração de dados do Neon.

Detalhes do plano em `/root/.claude/plans` (documento de arquitetura).
