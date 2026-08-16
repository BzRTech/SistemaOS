import { Perfil, StatusOS } from "./enums";

// Máquina de estados da OS. Cada transição declara os perfis que podem executá-la.
// Fonte única de verdade — o backend valida contra isto (nada de mudar status "no
// braço" como acontecia no PUT genérico da v1).

export interface Transicao {
  de: StatusOS;
  para: StatusOS;
  perfis: Perfil[];
  // exige justificativa/observação obrigatória (devolução, impedimento, cancelamento)
  exigeJustificativa?: boolean;
}

export const TRANSICOES: Transicao[] = [
  // Secretaria abre e encaminha para uma empresa
  { de: StatusOS.ABERTA, para: StatusOS.ENCAMINHADA, perfis: [Perfil.ADMIN, Perfil.SECRETARIA] },
  // Empresa direciona para uma equipe própria
  { de: StatusOS.ENCAMINHADA, para: StatusOS.DIRECIONADA, perfis: [Perfil.ADMIN, Perfil.EMPRESA] },
  // Empresa pode trocar a equipe antes do início (re-direcionar)
  { de: StatusOS.DIRECIONADA, para: StatusOS.DIRECIONADA, perfis: [Perfil.ADMIN, Perfil.EMPRESA] },
  // Equipe inicia execução em campo
  { de: StatusOS.DIRECIONADA, para: StatusOS.EM_EXECUCAO, perfis: [Perfil.ADMIN, Perfil.EQUIPE] },
  // Equipe conclui e envia para validação
  { de: StatusOS.EM_EXECUCAO, para: StatusOS.AGUARDANDO_VALIDACAO, perfis: [Perfil.ADMIN, Perfil.EQUIPE] },
  // Secretaria valida (fecha) ou devolve
  { de: StatusOS.AGUARDANDO_VALIDACAO, para: StatusOS.CONCLUIDA, perfis: [Perfil.ADMIN, Perfil.SECRETARIA] },
  { de: StatusOS.AGUARDANDO_VALIDACAO, para: StatusOS.DIRECIONADA, perfis: [Perfil.ADMIN, Perfil.SECRETARIA], exigeJustificativa: true },
  // Empresa devolve à secretaria
  { de: StatusOS.ENCAMINHADA, para: StatusOS.DEVOLVIDA, perfis: [Perfil.ADMIN, Perfil.EMPRESA], exigeJustificativa: true },
  { de: StatusOS.DIRECIONADA, para: StatusOS.DEVOLVIDA, perfis: [Perfil.ADMIN, Perfil.EMPRESA], exigeJustificativa: true },
  // Equipe registra impedimento em campo
  { de: StatusOS.EM_EXECUCAO, para: StatusOS.IMPEDIDA, perfis: [Perfil.ADMIN, Perfil.EQUIPE], exigeJustificativa: true },
  // Suspensão temporária e retomada
  { de: StatusOS.EM_EXECUCAO, para: StatusOS.SUSPENSA, perfis: [Perfil.ADMIN, Perfil.EMPRESA, Perfil.EQUIPE], exigeJustificativa: true },
  { de: StatusOS.SUSPENSA, para: StatusOS.EM_EXECUCAO, perfis: [Perfil.ADMIN, Perfil.EMPRESA, Perfil.EQUIPE] },
  // Cancelamento (evitar exclusão física)
  { de: StatusOS.ABERTA, para: StatusOS.CANCELADA, perfis: [Perfil.ADMIN, Perfil.SECRETARIA], exigeJustificativa: true },
  { de: StatusOS.ENCAMINHADA, para: StatusOS.CANCELADA, perfis: [Perfil.ADMIN, Perfil.SECRETARIA], exigeJustificativa: true },
];

export function encontrarTransicao(de: StatusOS, para: StatusOS): Transicao | undefined {
  return TRANSICOES.find((t) => t.de === de && t.para === para);
}

export function transicaoPermitida(de: StatusOS, para: StatusOS, perfil: Perfil): boolean {
  const t = encontrarTransicao(de, para);
  return !!t && t.perfis.includes(perfil);
}

export function proximosStatus(de: StatusOS, perfil: Perfil): StatusOS[] {
  return TRANSICOES.filter((t) => t.de === de && t.perfis.includes(perfil)).map((t) => t.para);
}
