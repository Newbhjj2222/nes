import { z } from "zod";

// Rwandan numbers in E.164, e.g. +250788123456. Other countries can be added later.
const phone = z.string().regex(/^\+\d{8,15}$/, "Phone must be in international format, e.g. +250788123456");

const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), "Use upper, lower case letters and a digit");

export const registerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: phone.optional(),
    password,
  })
  .refine((v) => v.email || v.phone, { message: "Provide an email or a phone number", path: ["email"] });

export const loginSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(3).max(255), // email or phone
  password: z.string().min(1).max(128),
});

export const forgotPasswordSchema = z.object({ identifier: z.string().trim().toLowerCase().min(3).max(255) });

export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(128),
  newPassword: password,
});

export const verifyRequestSchema = z.object({ channel: z.enum(["email", "phone"]) });

export const verifyConfirmSchema = z.object({
  channel: z.enum(["email", "phone"]),
  token: z.string().min(6).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
