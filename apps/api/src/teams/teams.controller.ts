import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { atualizarTeamSchema, criarTeamSchema, type CriarTeamInput } from "@sistemaos/shared";
import { Perfil } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod.pipe";
import { Roles, UsuarioAtual } from "../auth/decorators";
import type { TokenPayload } from "../auth/jwt.service";
import { TeamsService } from "./teams.service";

@Controller("teams")
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  listar(@UsuarioAtual() u: TokenPayload, @Query("empresaId") empresaId?: string) {
    return this.teams.listar(u, empresaId);
  }

  @Post()
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  criar(
    @UsuarioAtual() u: TokenPayload,
    @Body(new ZodValidationPipe(criarTeamSchema)) body: CriarTeamInput,
  ) {
    return this.teams.criar(u, body);
  }

  @Patch(":id")
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  atualizar(
    @UsuarioAtual() u: TokenPayload,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(atualizarTeamSchema)) body: Record<string, unknown>,
  ) {
    return this.teams.atualizar(u, id, body);
  }

  @Get(":id/membros")
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  membros(@UsuarioAtual() u: TokenPayload, @Param("id") id: string) {
    return this.teams.membros(u, id);
  }
}
