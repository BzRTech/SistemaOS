import argon2 from "argon2";
import { PrismaClient, Perfil, Prioridade } from "@prisma/client";
import { SLA_PADRAO_HORAS } from "@sistemaos/shared";

const prisma = new PrismaClient();

async function main() {
  // Admin inicial
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@sistemaos.local").toLowerCase();
  const adminSenha = process.env.ADMIN_SENHA ?? "admin123";
  const existente = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existente) {
    await prisma.user.create({
      data: {
        nome: "Administrador",
        email: adminEmail,
        senhaHash: await argon2.hash(adminSenha),
        perfil: Perfil.ADMIN,
      },
    });
    console.log(`Admin criado: ${adminEmail} / ${adminSenha}`);
  }

  // Regras de SLA padrão (configuráveis depois)
  for (const [prioridade, horas] of Object.entries(SLA_PADRAO_HORAS)) {
    await prisma.slaRule.upsert({
      where: { prioridade: prioridade as Prioridade },
      update: {},
      create: { prioridade: prioridade as Prioridade, horas },
    });
  }

  // Categorias com mínimos de foto (exemplo do Prompt-Mestre)
  const categorias = [
    { nome: "Pavimentação", minFotosAntes: 2, minFotosDurante: 3, minFotosDepois: 3 },
    { nome: "Iluminação", minFotosAntes: 1, minFotosDurante: 2, minFotosDepois: 2 },
    { nome: "Drenagem", minFotosAntes: 1, minFotosDurante: 2, minFotosDepois: 2 },
    { nome: "Manutenção Predial", minFotosAntes: 1, minFotosDurante: 1, minFotosDepois: 1 },
  ];
  for (const c of categorias) {
    await prisma.serviceOrderCategory.upsert({
      where: { nome: c.nome },
      update: {},
      create: c,
    });
  }

  console.log("Seed concluído.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
