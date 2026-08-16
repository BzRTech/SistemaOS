import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import { Perfil } from "@prisma/client";
import type { TokenPayload } from "./jwt.service";

export const IS_PUBLIC_KEY = "isPublic";
// Marca uma rota como pública (dispensa autenticação).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = "roles";
// Restringe uma rota aos perfis informados. Sem @Roles, qualquer usuário autenticado.
export const Roles = (...perfis: Perfil[]) => SetMetadata(ROLES_KEY, perfis);

// Injeta o usuário autenticado (payload do token) no handler.
export const UsuarioAtual = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TokenPayload => {
    const req = ctx.switchToHttp().getRequest();
    return req.usuario;
  },
);
