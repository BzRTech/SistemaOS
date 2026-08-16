import { Injectable } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { Perfil } from "@prisma/client";

export interface TokenPayload {
  sub: string;
  perfil: Perfil;
  secretariaId: string | null;
  empresaId: string | null;
  equipeId: string | null;
}

const SECRET = process.env.JWT_SECRET ?? "dev-inseguro-troque-em-producao";
const ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? "15m";

@Injectable()
export class JwtService {
  assinarAccess(payload: TokenPayload): string {
    const opcoes = { expiresIn: ACCESS_TTL } as jwt.SignOptions;
    return jwt.sign(payload, SECRET, opcoes);
  }

  verificar(token: string): TokenPayload {
    return jwt.verify(token, SECRET) as TokenPayload;
  }
}
