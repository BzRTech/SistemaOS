import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import {
  atualizarUsuarioSchema,
  criarUsuarioSchema,
  type CriarUsuarioInput,
} from "@sistemaos/shared";
import { Perfil } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod.pipe";
import { Roles, UsuarioAtual } from "../auth/decorators";
import type { TokenPayload } from "../auth/jwt.service";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  listar(@UsuarioAtual() u: TokenPayload) {
    return this.users.listar(u);
  }

  @Post()
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  criar(
    @UsuarioAtual() u: TokenPayload,
    @Body(new ZodValidationPipe(criarUsuarioSchema)) body: CriarUsuarioInput,
  ) {
    return this.users.criar(u, body);
  }

  @Patch(":id")
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  atualizar(
    @UsuarioAtual() u: TokenPayload,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(atualizarUsuarioSchema)) body: Record<string, unknown>,
  ) {
    return this.users.atualizar(u, id, body);
  }

  @Delete(":id")
  @Roles(Perfil.ADMIN, Perfil.EMPRESA)
  desativar(@UsuarioAtual() u: TokenPayload, @Param("id") id: string) {
    return this.users.desativar(u, id);
  }
}
