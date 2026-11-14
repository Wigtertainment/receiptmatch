import { z } from 'zod';

export const moneySchema: z.ZodObject<{ coefficient: z.ZodString; currency: z.ZodString; scale: z.ZodNumber; }, z.core.$strict> = z.strictObject({
    coefficient: z
        .string()
        .regex(/^(0|-?[1-9]\d*)$/)
        .max(128),
    currency: z.string().regex(/^[A-Z]{3}$/),
    scale: z.number().int().min(0).max(18)
});
export type Money = z.infer<typeof moneySchema>;

export function sameMoneyValue(left: Money, right: Money): boolean {
    return left.currency === right.currency && BigInt(left.coefficient) * 10n ** BigInt(right.scale) === BigInt(right.coefficient) * 10n ** BigInt(left.scale);
}
