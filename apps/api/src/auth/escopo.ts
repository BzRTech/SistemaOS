import { Perfil } from "@prisma/client";
import type { TokenPayload } from "./jwt.service";

// Recorte de acesso por linha (row-level scoping) para Ordens de Serviço.
// Fonte ÚNICA da regra de isolamento organizacional — usada tanto para montar
// o filtro de listagem quanto para autorizar o acesso a uma OS específica.
// Corrige de raiz a classe de bug da v1 (checagem espalhada e por nome de equipe).

export interface OrdemEscopo {
  secretariaId: string | null;
  empresaId: string | null;
  equipeId: string | null;
}

/**
 * Cláusula `where` do Prisma que limita a listagem ao que o usuário pode ver.
 * - ADMIN: tudo.
 * - SECRETARIA: apenas OS da própria secretaria.
 * - EMPRESA: apenas OS encaminhadas para a própria empresa.
 * - EQUIPE: apenas OS direcionadas para a própria equipe (e da própria empresa).
 */
export function filtroOrdensPorEscopo(u: TokenPayload): Record<string, unknown> {
  switch (u.perfil) {
    case Perfil.ADMIN:
      return {};
    case Perfil.SECRETARIA:
      return { secretariaId: u.secretariaId };
    case Perfil.EMPRESA:
      return { empresaId: u.empresaId };
    case Perfil.EQUIPE:
      // exige empresa E equipe: nomes de equipe podem repetir entre empresas
      return { empresaId: u.empresaId, equipeId: u.equipeId };
    default:
      // fail-closed: perfil desconhecido não vê nada
      return { id: "__nenhum__" };
  }
}

/**
 * Autoriza acesso a UMA ordem específica (bloqueia troca de ID na URL/API).
 */
export function podeAcessarOrdem(u: TokenPayload, ordem: OrdemEscopo): boolean {
  switch (u.perfil) {
    case Perfil.ADMIN:
      return true;
    case Perfil.SECRETARIA:
      return !!u.secretariaId && ordem.secretariaId === u.secretariaId;
    case Perfil.EMPRESA:
      return !!u.empresaId && ordem.empresaId === u.empresaId;
    case Perfil.EQUIPE:
      return (
        !!u.empresaId &&
        !!u.equipeId &&
        ordem.empresaId === u.empresaId &&
        ordem.equipeId === u.equipeId
      );
    default:
      return false;
  }
}
