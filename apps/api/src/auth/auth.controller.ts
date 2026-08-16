import { Body, Controller, Get, Post, UseGuards, UsePipes } from "@nestjs/common";
import { loginSchema, type LoginInput } from "@sistemaos/shared";
import { ZodValidationPipe } from "../common/zod.pipe";
import { AuthService } from "./auth.service";
import { UsuarioAtual } from "./decorators";
import { JwtAuthGuard } from "./jwt-auth.guard";
import type { TokenPayload } from "./jwt.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @UsePipes(new ZodValidationPipe(loginSchema))
  login(@Body() body: LoginInput) {
    return this.auth.login(body.email, body.senha);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@UsuarioAtual() usuario: TokenPayload) {
    return usuario;
  }
}
