import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import {
  atualizarEmpresaSchema,
  criarEmpresaSchema,
  type CriarEmpresaInput,
} from "@sistemaos/shared";
import { Perfil } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod.pipe";
import { Roles, UsuarioAtual } from "../auth/decorators";
import type { TokenPayload } from "../auth/jwt.service";
import { PrismaService } from "../prisma/prisma.service";

@Controller("empresas")
export class EmpresasController {
  constructor(private readonly prisma: PrismaService) {}

  // ADMIN vê todas; EMPRESA vê apenas a própria.
  @Get()
  listar(@UsuarioAtual() u: TokenPayload) {
    if (u.perfil === Perfil.EMPRESA) {
      return this.prisma.empresa.findMany({ where: { id: u.empresaId ?? "__nenhum__" } });
    }
    return this.prisma.empresa.findMany({ orderBy: { razaoSocial: "asc" } });
  }

  @Post()
  @Roles(Perfil.ADMIN)
  criar(@Body(new ZodValidationPipe(criarEmpresaSchema)) body: CriarEmpresaInput) {
    return this.prisma.empresa.create({ data: body });
  }

  @Patch(":id")
  @Roles(Perfil.ADMIN)
  atualizar(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(atualizarEmpresaSchema)) body: Record<string, unknown>,
  ) {
    return this.prisma.empresa.update({ where: { id }, data: body });
  }
}
