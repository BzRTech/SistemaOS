import { describe, expect, it, vi, beforeEach } from "vitest";
import { Perfil } from "@prisma/client";
import { UsersService } from "./users.service";
import type { TokenPayload } from "../auth/jwt.service";

// Testa as regras de escopo/vínculo sem tocar no banco (Prisma mockado).
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "novo" }),
      update: vi.fn().mockResolvedValue({ id: "u" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    team: { findUnique: vi.fn() },
    ...overrides,
  } as never;
}

const gestorA: TokenPayload = {
  sub: "gA",
  perfil: Perfil.EMPRESA,
  secretariaId: null,
  empresaId: "A",
  equipeId: null,
};

describe("UsersService — escopo de empresa", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: UsersService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new UsersService(prisma);
  });

  it("EMPRESA não pode criar usuário ADMIN", async () => {
    await expect(
      service.criar(gestorA, {
        nome: "x",
        email: "x@x.com",
        senha: "senha123",
        perfil: Perfil.ADMIN,
      }),
    ).rejects.toThrow(/equipe/i);
  });

  it("EMPRESA não pode vincular membro a equipe de outra empresa", async () => {
    (prisma as any).team.findUnique.mockResolvedValue({ id: "tB", empresaId: "B" });
    await expect(
      service.criar(gestorA, {
        nome: "intruso",
        email: "i@x.com",
        senha: "senha123",
        perfil: Perfil.EQUIPE,
        empresaId: "B",
        equipeId: "tB",
      }),
    ).rejects.toThrow(/equipe inválida/i);
  });

  it("EMPRESA cria membro na própria equipe (empresaId é forçado)", async () => {
    (prisma as any).team.findUnique.mockResolvedValue({ id: "tA", empresaId: "A" });
    await service.criar(gestorA, {
      nome: "campo",
      email: "c@x.com",
      senha: "senha123",
      perfil: Perfil.EQUIPE,
      empresaId: "B", // tenta forjar outra empresa
      equipeId: "tA",
    });
    const arg = (prisma as any).user.create.mock.calls[0][0];
    expect(arg.data.empresaId).toBe("A"); // forçado para a empresa do gestor
  });

  it("EMPRESA não desativa usuário de outra empresa", async () => {
    (prisma as any).user.findUnique.mockResolvedValue({ id: "u2", empresaId: "B" });
    await expect(service.desativar(gestorA, "u2")).rejects.toThrow(/outra empresa/i);
  });
});
