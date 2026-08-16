import { Module } from "@nestjs/common";
import { EmpresasController } from "./empresas.controller";

@Module({
  controllers: [EmpresasController],
})
export class EmpresasModule {}
