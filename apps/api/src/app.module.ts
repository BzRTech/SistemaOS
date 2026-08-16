import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";
import { HealthController } from "./health.controller";
import { PrismaModule } from "./prisma/prisma.module";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [HealthController],
  providers: [
    // RolesGuard é global; JwtAuthGuard é aplicado por rota via @UseGuards
    // (rotas públicas como /auth/login e /health não exigem token).
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

export { JwtAuthGuard };
