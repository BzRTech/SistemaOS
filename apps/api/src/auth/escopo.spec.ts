import { describe, expect, it } from "vitest";
import { Perfil } from "@prisma/client";
import type { TokenPayload } from "./jwt.service";
import { filtroOrdensPorEscopo, podeAcessarOrdem } from "./escopo";

function usuario(p: Partial<TokenPayload>): TokenPayload {
  return { sub: "u", perfil: Perfil.EQUIPE, secretariaId: null, empresaId: null, equipeId: null, ...p };
}

describe("filtroOrdensPorEscopo", () => {
  it("admin vê tudo (sem filtro)", () => {
    expect(filtroOrdensPorEscopo(usuario({ perfil: Perfil.ADMIN }))).toEqual({});
  });
  it("secretaria filtra pela própria secretaria", () => {
    expect(filtroOrdensPorEscopo(usuario({ perfil: Perfil.SECRETARIA, secretariaId: "s1" }))).toEqual({
      secretariaId: "s1",
    });
  });
  it("empresa filtra pela própria empresa", () => {
    expect(filtroOrdensPorEscopo(usuario({ perfil: Perfil.EMPRESA, empresaId: "e1" }))).toEqual({
      empresaId: "e1",
    });
  });
  it("equipe filtra por empresa E equipe", () => {
    expect(
      filtroOrdensPorEscopo(usuario({ perfil: Perfil.EQUIPE, empresaId: "e1", equipeId: "t1" })),
    ).toEqual({ empresaId: "e1", equipeId: "t1" });
  });
});

describe("podeAcessarOrdem (isolamento entre organizações)", () => {
  const ordemEmpresaA = { secretariaId: "s1", empresaId: "A", equipeId: "t1" };

  it("empresa A acessa OS da empresa A", () => {
    expect(podeAcessarOrdem(usuario({ perfil: Perfil.EMPRESA, empresaId: "A" }), ordemEmpresaA)).toBe(true);
  });

  it("empresa B NÃO acessa OS da empresa A (troca de ID bloqueada)", () => {
    expect(podeAcessarOrdem(usuario({ perfil: Perfil.EMPRESA, empresaId: "B" }), ordemEmpresaA)).toBe(false);
  });

  it("equipe da empresa B com mesmo nome de equipe NÃO acessa OS da empresa A", () => {
    // colisão clássica: "Equipe 1" existe em A e em B
    const intruso = usuario({ perfil: Perfil.EQUIPE, empresaId: "B", equipeId: "t1" });
    expect(podeAcessarOrdem(intruso, ordemEmpresaA)).toBe(false);
  });

  it("equipe correta (empresa A, equipe t1) acessa", () => {
    const dono = usuario({ perfil: Perfil.EQUIPE, empresaId: "A", equipeId: "t1" });
    expect(podeAcessarOrdem(dono, ordemEmpresaA)).toBe(true);
  });

  it("equipe certa mas de outra empresa NÃO acessa", () => {
    const outra = usuario({ perfil: Perfil.EQUIPE, empresaId: "A", equipeId: "t2" });
    expect(podeAcessarOrdem(outra, ordemEmpresaA)).toBe(false);
  });

  it("secretaria de outra secretaria NÃO acessa", () => {
    expect(podeAcessarOrdem(usuario({ perfil: Perfil.SECRETARIA, secretariaId: "s2" }), ordemEmpresaA)).toBe(false);
  });
});
