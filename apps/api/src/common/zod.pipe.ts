import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

// Valida o body contra um schema zod dos contratos compartilhados.
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return result.data;
  }
}
