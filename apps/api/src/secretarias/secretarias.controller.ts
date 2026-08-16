import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import {
  atualizarSecretariaSchema,
  criarSecretariaSchema,
  type CriarSecretariaInput,
} from "@sistemaos/shared";
import { Perfil } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod.pipe";
import { Roles } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";

@Controller("secretarias")
export class SecretariasController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles(Perfil.ADMIN)
  listar() {
    return this.prisma.secretaria.findMany({ orderBy: { nome: "asc" } });
  }

  @Post()
  @Roles(Perfil.ADMIN)
  criar(@Body(new ZodValidationPipe(criarSecretariaSchema)) body: CriarSecretariaInput) {
    return this.prisma.secretaria.create({ data: body });
  }

  @Patch(":id")
  @Roles(Perfil.ADMIN)
  atualizar(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(atualizarSecretariaSchema)) body: Record<string, unknown>,
  ) {
    return this.prisma.secretaria.update({ where: { id }, data: body });
  }
}
