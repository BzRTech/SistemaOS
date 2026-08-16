// Espelham os enums do Prisma — fonte única para API e web.

export const Perfil = {
  ADMIN: "ADMIN",
  SECRETARIA: "SECRETARIA",
  EMPRESA: "EMPRESA",
  EQUIPE: "EQUIPE",
} as const;
export type Perfil = (typeof Perfil)[keyof typeof Perfil];

export const StatusOS = {
  ABERTA: "ABERTA",
  ENCAMINHADA: "ENCAMINHADA",
  DIRECIONADA: "DIRECIONADA",
  EM_EXECUCAO: "EM_EXECUCAO",
  AGUARDANDO_VALIDACAO: "AGUARDANDO_VALIDACAO",
  CONCLUIDA: "CONCLUIDA",
  DEVOLVIDA: "DEVOLVIDA",
  CANCELADA: "CANCELADA",
  SUSPENSA: "SUSPENSA",
  IMPEDIDA: "IMPEDIDA",
} as const;
export type StatusOS = (typeof StatusOS)[keyof typeof StatusOS];

export const Prioridade = {
  BAIXA: "BAIXA",
  NORMAL: "NORMAL",
  ALTA: "ALTA",
  URGENTE: "URGENTE",
  EMERGENCIAL: "EMERGENCIAL",
} as const;
export type Prioridade = (typeof Prioridade)[keyof typeof Prioridade];

export const TipoFoto = {
  ANTES: "ANTES",
  DURANTE: "DURANTE",
  DEPOIS: "DEPOIS",
  EVIDENCIA: "EVIDENCIA",
  IMPEDIMENTO: "IMPEDIMENTO",
  MATERIAL: "MATERIAL",
  OUTROS: "OUTROS",
} as const;
export type TipoFoto = (typeof TipoFoto)[keyof typeof TipoFoto];

// SLA padrão (horas) por prioridade — configurável pelo admin (tabela sla_rules).
export const SLA_PADRAO_HORAS: Record<Prioridade, number> = {
  BAIXA: 240, // 10 dias
  NORMAL: 120, // 5 dias
  ALTA: 72, // 3 dias
  URGENTE: 24,
  EMERGENCIAL: 4,
};
