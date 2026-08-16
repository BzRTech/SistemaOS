import { Module } from "@nestjs/common";
import { SecretariasController } from "./secretarias.controller";

@Module({
  controllers: [SecretariasController],
})
export class SecretariasModule {}
