import { z } from "zod";
import { Perfil, Prioridade } from "./enums";

// Contratos de request validados no backend (e reutilizáveis no front).

export const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const criarUsuarioSchema = z.object({
  nome: z.string().min(1),
  email: z.string().email(),
  senha: z.string().min(6),
  perfil: z.nativeEnum(Perfil),
  secretariaId: z.string().uuid().optional(),
  empresaId: z.string().uuid().optional(),
  equipeId: z.string().uuid().optional(),
});
export type CriarUsuarioInput = z.infer<typeof criarUsuarioSchema>;

export const criarOrdemSchema = z.object({
  titulo: z.string().min(1),
  descricao: z.string().optional(),
  prioridade: z.nativeEnum(Prioridade).default(Prioridade.NORMAL),
  categoriaId: z.string().uuid().optional(),
  endereco: z.string().optional(),
  bairro: z.string().optional(),
  municipio: z.string().optional(),
  cep: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  referencia: z.string().optional(),
  prazoDesejado: z.string().datetime().optional(),
});
export type CriarOrdemInput = z.infer<typeof criarOrdemSchema>;

export const mudarStatusSchema = z.object({
  para: z.string(),
  observacao: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});
export type MudarStatusInput = z.infer<typeof mudarStatusSchema>;
