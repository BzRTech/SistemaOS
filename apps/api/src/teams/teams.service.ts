import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Perfil } from "@prisma/client";
import type { CriarTeamInput } from "@sistemaos/shared";
import type { TokenPayload } from "../auth/jwt.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  // Resolve a empresa alvo respeitando o escopo do usuário.
  private empresaAlvo(u: TokenPayload, empresaIdInput?: string): string {
    if (u.perfil === Perfil.EMPRESA) {
      if (!u.empresaId) throw new ForbiddenException("Usuário empresa sem vínculo");
      return u.empresaId; // EMPRESA ignora o body e usa sempre a própria
    }
    // ADMIN precisa informar a empresa
    if (!empresaIdInput) throw new BadRequestException("empresaId é obrigatório para ADMIN");
    return empresaIdInput;
  }

  listar(u: TokenPayload, empresaIdFiltro?: string) {
    const where =
      u.perfil === Perfil.EMPRESA
        ? { empresaId: u.empresaId ?? "__nenhum__" }
        : empresaIdFiltro
          ? { empresaId: empresaIdFiltro }
          : {};
    return this.prisma.team.findMany({ where, orderBy: { nome: "asc" } });
  }

  criar(u: TokenPayload, body: CriarTeamInput) {
    const empresaId = this.empresaAlvo(u, body.empresaId);
    const { empresaId: _ignora, ...resto } = body;
    return this.prisma.team.create({ data: { ...resto, empresaId } });
  }

  private async garantirAcesso(u: TokenPayload, teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Equipe não encontrada");
    if (u.perfil === Perfil.EMPRESA && team.empresaId !== u.empresaId) {
      throw new ForbiddenException("Equipe de outra empresa");
    }
    return team;
  }

  async atualizar(u: TokenPayload, teamId: string, data: Record<string, unknown>) {
    await this.garantirAcesso(u, teamId);
    // não permite mover a equipe de empresa por aqui
    delete data.empresaId;
    return this.prisma.team.update({ where: { id: teamId }, data });
  }

  async membros(u: TokenPayload, teamId: string) {
    await this.garantirAcesso(u, teamId);
    return this.prisma.user.findMany({
      where: { equipeId: teamId },
      select: { id: true, nome: true, email: true, ativo: true },
      orderBy: { nome: "asc" },
    });
  }
}
