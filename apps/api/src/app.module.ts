import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";
import { EmpresasModule } from "./empresas/empresas.module";
import { HealthController } from "./health.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { SecretariasModule } from "./secretarias/secretarias.module";
import { TeamsModule } from "./teams/teams.module";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    SecretariasModule,
    EmpresasModule,
    TeamsModule,
    UsersModule,
  ],
  controllers: [HealthController],
  providers: [
    // Ordem importa: JwtAuthGuard autentica e popula req.usuario ANTES do
    // RolesGuard checar o perfil. Rotas @Public() dispensam token.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

export { JwtAuthGuard };
