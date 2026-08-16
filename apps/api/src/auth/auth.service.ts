import { Injectable, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";
import { JwtService, TokenPayload } from "./jwt.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, senha: string): Promise<{ accessToken: string; usuario: unknown }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.ativo) {
      throw new UnauthorizedException("Credenciais inválidas");
    }
    const ok = await argon2.verify(user.senhaHash, senha);
    if (!ok) {
      throw new UnauthorizedException("Credenciais inválidas");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { ultimoAcesso: new Date() },
    });

    const payload: TokenPayload = {
      sub: user.id,
      perfil: user.perfil,
      secretariaId: user.secretariaId,
      empresaId: user.empresaId,
      equipeId: user.equipeId,
    };

    return {
      accessToken: this.jwt.assinarAccess(payload),
      usuario: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        perfil: user.perfil,
      },
    };
  }
}
