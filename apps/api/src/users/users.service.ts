import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import argon2 from "argon2";
import { Perfil } from "@prisma/client";
import type { CriarUsuarioInput } from "@sistemaos/shared";
import type { TokenPayload } from "../auth/jwt.service";
import { PrismaService } from "../prisma/prisma.service";

const PUBLICO = {
  id: true,
  nome: true,
  email: true,
  perfil: true,
  ativo: true,
  secretariaId: true,
  empresaId: true,
  equipeId: true,
  ultimoAcesso: true,
  criadoEm: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  listar(u: TokenPayload) {
    const where = u.perfil === Perfil.EMPRESA ? { empresaId: u.empresaId ?? "__nenhum__" } : {};
    return this.prisma.user.findMany({ where, select: PUBLICO, orderBy: { nome: "asc" } });
  }

  async criar(u: TokenPayload, body: CriarUsuarioInput) {
    // EMPRESA só cria membros de equipe (EQUIPE) da própria empresa.
    if (u.perfil === Perfil.EMPRESA) {
      if (body.perfil !== Perfil.EQUIPE) {
        throw new ForbiddenException("Empresa só pode criar usuários de equipe");
      }
      body.empresaId = u.empresaId ?? undefined;
      if (!body.equipeId) throw new BadRequestException("equipeId é obrigatório");
      await this.validarEquipeDaEmpresa(body.equipeId, u.empresaId);
    }

    // Coerência de vínculo por perfil
    this.validarVinculo(body);

    const email = body.email.toLowerCase();
    const jaExiste = await this.prisma.user.findUnique({ where: { email } });
    if (jaExiste) throw new ConflictException("E-mail já cadastrado");

    return this.prisma.user.create({
      data: {
        nome: body.nome,
        email,
        senhaHash: await argon2.hash(body.senha),
        perfil: body.perfil,
        secretariaId: body.secretariaId ?? null,
        empresaId: body.empresaId ?? null,
        equipeId: body.equipeId ?? null,
      },
      select: PUBLICO,
    });
  }

  async atualizar(u: TokenPayload, id: string, body: Record<string, unknown>) {
    const alvo = await this.prisma.user.findUnique({ where: { id } });
    if (!alvo) throw new NotFoundException("Usuário não encontrado");
    if (u.perfil === Perfil.EMPRESA && alvo.empresaId !== u.empresaId) {
      throw new ForbiddenException("Usuário de outra empresa");
    }

    const data: Record<string, unknown> = {};
    if (typeof body.nome === "string") data.nome = body.nome;
    if (typeof body.ativo === "boolean") data.ativo = body.ativo;
    if (typeof body.senha === "string") data.senhaHash = await argon2.hash(body.senha);
    // ADMIN pode remanejar vínculos
    if (u.perfil === Perfil.ADMIN) {
      if ("secretariaId" in body) data.secretariaId = body.secretariaId ?? null;
      if ("empresaId" in body) data.empresaId = body.empresaId ?? null;
      if ("equipeId" in body) data.equipeId = body.equipeId ?? null;
    }
    return this.prisma.user.update({ where: { id }, data, select: PUBLICO });
  }

  async desativar(u: TokenPayload, id: string) {
    if (id === u.sub) throw new BadRequestException("Não é possível desativar a si mesmo");
    const alvo = await this.prisma.user.findUnique({ where: { id } });
    if (!alvo) throw new NotFoundException("Usuário não encontrado");
    if (u.perfil === Perfil.EMPRESA && alvo.empresaId !== u.empresaId) {
      throw new ForbiddenException("Usuário de outra empresa");
    }
    return this.prisma.user.update({ where: { id }, data: { ativo: false }, select: PUBLICO });
  }

  private async validarEquipeDaEmpresa(equipeId: string, empresaId: string | null) {
    const team = await this.prisma.team.findUnique({ where: { id: equipeId } });
    if (!team || team.empresaId !== empresaId) {
      throw new BadRequestException("Equipe inválida para esta empresa");
    }
  }

  private validarVinculo(body: CriarUsuarioInput) {
    switch (body.perfil) {
      case Perfil.SECRETARIA:
        if (!body.secretariaId) throw new BadRequestException("secretariaId é obrigatório");
        break;
      case Perfil.EMPRESA:
        if (!body.empresaId) throw new BadRequestException("empresaId é obrigatório");
        break;
      case Perfil.EQUIPE:
        if (!body.empresaId || !body.equipeId)
          throw new BadRequestException("empresaId e equipeId são obrigatórios");
        break;
      default:
        break; // ADMIN sem vínculo
    }
  }
}
