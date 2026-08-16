-- CreateEnum
CREATE TYPE "Perfil" AS ENUM ('ADMIN', 'SECRETARIA', 'EMPRESA', 'EQUIPE');

-- CreateEnum
CREATE TYPE "StatusOS" AS ENUM ('ABERTA', 'ENCAMINHADA', 'DIRECIONADA', 'EM_EXECUCAO', 'AGUARDANDO_VALIDACAO', 'CONCLUIDA', 'DEVOLVIDA', 'CANCELADA', 'SUSPENSA', 'IMPEDIDA');

-- CreateEnum
CREATE TYPE "Prioridade" AS ENUM ('BAIXA', 'NORMAL', 'ALTA', 'URGENTE', 'EMERGENCIAL');

-- CreateEnum
CREATE TYPE "TipoFoto" AS ENUM ('ANTES', 'DURANTE', 'DEPOIS', 'EVIDENCIA', 'IMPEDIMENTO', 'MATERIAL', 'OUTROS');

-- CreateEnum
CREATE TYPE "TipoCheckpoint" AS ENUM ('CHECK_IN', 'CHECK_OUT');

-- CreateTable
CREATE TABLE "secretarias" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secretarias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "empresas" (
    "id" TEXT NOT NULL,
    "razao_social" TEXT NOT NULL,
    "nome_fantasia" TEXT,
    "cnpj" TEXT,
    "email" TEXT,
    "telefone" TEXT,
    "endereco" TEXT,
    "municipio" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empresas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "codigo" TEXT,
    "tipo" TEXT,
    "telefone" TEXT,
    "area_atuacao" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "empresa_id" TEXT NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "senha_hash" TEXT NOT NULL,
    "perfil" "Perfil" NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_acesso" TIMESTAMP(3),
    "secretaria_id" TEXT,
    "empresa_id" TEXT,
    "equipe_id" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "revogado" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_categories" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "min_fotos_antes" INTEGER NOT NULL DEFAULT 0,
    "min_fotos_durante" INTEGER NOT NULL DEFAULT 0,
    "min_fotos_depois" INTEGER NOT NULL DEFAULT 0,
    "tolerancia_gps_m" INTEGER NOT NULL DEFAULT 100,
    "ativo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_order_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_rules" (
    "id" TEXT NOT NULL,
    "prioridade" "Prioridade" NOT NULL,
    "horas" INTEGER NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sla_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_orders" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT,
    "status" "StatusOS" NOT NULL DEFAULT 'ABERTA',
    "prioridade" "Prioridade" NOT NULL DEFAULT 'NORMAL',
    "endereco" TEXT,
    "numero_endereco" TEXT,
    "complemento" TEXT,
    "bairro" TEXT,
    "municipio" TEXT,
    "cep" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "referencia" TEXT,
    "data_abertura" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prazo_desejado" TIMESTAMP(3),
    "data_limite" TIMESTAMP(3),
    "data_encaminhamento" TIMESTAMP(3),
    "data_direcionamento" TIMESTAMP(3),
    "data_inicio" TIMESTAMP(3),
    "data_conclusao" TIMESTAMP(3),
    "observacoes" TEXT,
    "secretaria_id" TEXT,
    "empresa_id" TEXT,
    "equipe_id" TEXT,
    "categoria_id" TEXT,
    "solicitante_id" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_status_history" (
    "id" TEXT NOT NULL,
    "ordem_id" TEXT NOT NULL,
    "status_anterior" "StatusOS",
    "status_novo" "StatusOS" NOT NULL,
    "observacao" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "usuario_id" TEXT,
    "perfil" "Perfil",
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_photos" (
    "id" TEXT NOT NULL,
    "ordem_id" TEXT NOT NULL,
    "tipo" "TipoFoto" NOT NULL DEFAULT 'EVIDENCIA',
    "storage_key" TEXT NOT NULL,
    "thumb_key" TEXT,
    "hash" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    "capturada_em" TIMESTAMP(3),
    "recebida_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observacao" TEXT,
    "dispositivo" TEXT,
    "usuario_id" TEXT,
    "client_uuid" TEXT,

    CONSTRAINT "service_order_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_checkpoints" (
    "id" TEXT NOT NULL,
    "ordem_id" TEXT NOT NULL,
    "tipo" "TipoCheckpoint" NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    "usuario_id" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_uuid" TEXT,

    CONSTRAINT "service_order_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT,
    "perfil" "Perfil",
    "acao" TEXT NOT NULL,
    "entidade" TEXT NOT NULL,
    "entidade_id" TEXT,
    "valor_antes" JSONB,
    "valor_depois" JSONB,
    "ip" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "corpo" TEXT,
    "lida" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "empresas_cnpj_key" ON "empresas"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "teams_empresa_id_codigo_key" ON "teams"("empresa_id", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_perfil_idx" ON "users"("perfil");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_categories_nome_key" ON "service_order_categories"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "sla_rules_prioridade_key" ON "sla_rules"("prioridade");

-- CreateIndex
CREATE UNIQUE INDEX "service_orders_numero_key" ON "service_orders"("numero");

-- CreateIndex
CREATE INDEX "service_orders_status_idx" ON "service_orders"("status");

-- CreateIndex
CREATE INDEX "service_orders_empresa_id_idx" ON "service_orders"("empresa_id");

-- CreateIndex
CREATE INDEX "service_orders_equipe_id_idx" ON "service_orders"("equipe_id");

-- CreateIndex
CREATE INDEX "service_orders_secretaria_id_idx" ON "service_orders"("secretaria_id");

-- CreateIndex
CREATE INDEX "service_orders_criado_em_idx" ON "service_orders"("criado_em" DESC);

-- CreateIndex
CREATE INDEX "service_order_status_history_ordem_id_idx" ON "service_order_status_history"("ordem_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_photos_client_uuid_key" ON "service_order_photos"("client_uuid");

-- CreateIndex
CREATE INDEX "service_order_photos_ordem_id_idx" ON "service_order_photos"("ordem_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_checkpoints_client_uuid_key" ON "service_order_checkpoints"("client_uuid");

-- CreateIndex
CREATE INDEX "service_order_checkpoints_ordem_id_idx" ON "service_order_checkpoints"("ordem_id");

-- CreateIndex
CREATE INDEX "audit_logs_entidade_entidade_id_idx" ON "audit_logs"("entidade", "entidade_id");

-- CreateIndex
CREATE INDEX "notifications_usuario_id_lida_idx" ON "notifications"("usuario_id", "lida");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_secretaria_id_fkey" FOREIGN KEY ("secretaria_id") REFERENCES "secretarias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_equipe_id_fkey" FOREIGN KEY ("equipe_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_secretaria_id_fkey" FOREIGN KEY ("secretaria_id") REFERENCES "secretarias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_equipe_id_fkey" FOREIGN KEY ("equipe_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "service_order_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_solicitante_id_fkey" FOREIGN KEY ("solicitante_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_status_history" ADD CONSTRAINT "service_order_status_history_ordem_id_fkey" FOREIGN KEY ("ordem_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_status_history" ADD CONSTRAINT "service_order_status_history_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_photos" ADD CONSTRAINT "service_order_photos_ordem_id_fkey" FOREIGN KEY ("ordem_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_photos" ADD CONSTRAINT "service_order_photos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_checkpoints" ADD CONSTRAINT "service_order_checkpoints_ordem_id_fkey" FOREIGN KEY ("ordem_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_checkpoints" ADD CONSTRAINT "service_order_checkpoints_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
