import { describe, expect, it } from "vitest";
import { Perfil, StatusOS, transicaoPermitida, proximosStatus } from "@sistemaos/shared";

describe("máquina de estados da OS", () => {
  it("secretaria pode ABERTA -> ENCAMINHADA", () => {
    expect(transicaoPermitida(StatusOS.ABERTA, StatusOS.ENCAMINHADA, Perfil.SECRETARIA)).toBe(true);
  });

  it("empresa NÃO pode ABERTA -> ENCAMINHADA", () => {
    expect(transicaoPermitida(StatusOS.ABERTA, StatusOS.ENCAMINHADA, Perfil.EMPRESA)).toBe(false);
  });

  it("empresa pode ENCAMINHADA -> DIRECIONADA", () => {
    expect(transicaoPermitida(StatusOS.ENCAMINHADA, StatusOS.DIRECIONADA, Perfil.EMPRESA)).toBe(true);
  });

  it("equipe pode DIRECIONADA -> EM_EXECUCAO", () => {
    expect(transicaoPermitida(StatusOS.DIRECIONADA, StatusOS.EM_EXECUCAO, Perfil.EQUIPE)).toBe(true);
  });

  it("equipe NÃO pode pular ABERTA -> CONCLUIDA (transição inexistente)", () => {
    expect(transicaoPermitida(StatusOS.ABERTA, StatusOS.CONCLUIDA, Perfil.EQUIPE)).toBe(false);
  });

  it("proximosStatus reflete o perfil", () => {
    expect(proximosStatus(StatusOS.AGUARDANDO_VALIDACAO, Perfil.SECRETARIA)).toContain(StatusOS.CONCLUIDA);
    expect(proximosStatus(StatusOS.AGUARDANDO_VALIDACAO, Perfil.EQUIPE)).toHaveLength(0);
  });
});
