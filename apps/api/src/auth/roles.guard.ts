import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Perfil } from "@prisma/client";
import { ROLES_KEY } from "./decorators";

// Gate de perfil (RBAC). Roda depois do JwtAuthGuard, então req.usuario já existe.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const perfis = this.reflector.getAllAndOverride<Perfil[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!perfis || perfis.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const perfil: Perfil | undefined = req.usuario?.perfil;
    if (!perfil || !perfis.includes(perfil)) {
      throw new ForbiddenException("Perfil sem permissão para esta ação");
    }
    return true;
  }
}
