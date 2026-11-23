import { z } from 'zod';

export const newPasswordSchema = z.string().min(12, 'Use at least 12 characters for your password.').max(128, 'Use no more than 128 characters.');
export const setupPasswordSchema = z.object({ password: newPasswordSchema, confirmPassword: z.string().max(128) }).strict()
  .refine(value => value.password === value.confirmPassword, { message: 'The passwords do not match.', path: ['confirmPassword'] });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(256),
  password: newPasswordSchema,
  confirmPassword: z.string().max(128),
}).strict()
  .refine(value => value.password === value.confirmPassword, { message: 'The passwords do not match.', path: ['confirmPassword'] })
  .refine(value => value.password !== value.currentPassword, { message: 'Choose a password different from your current password.', path: ['password'] });

type Identity = { userId: string; email: string; active: boolean };
type VerifiedIdentity = { userId: string; email: string };
export class PasswordChangeError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) { super(message); this.status = status; }
}

/** Identity comes only from the server's active membership and verified Auth response. */
export async function changeOwnPassword(input: z.infer<typeof changePasswordSchema>, dependencies: {
  currentMember: () => Promise<Identity>;
  reauthenticate: (email: string, password: string) => Promise<VerifiedIdentity>;
  update: (password: string) => Promise<VerifiedIdentity>;
}): Promise<void> {
  const actor = await dependencies.currentMember();
  if (!actor.active) throw new PasswordChangeError('Your account no longer has active workspace access.');
  const matchesActor = (identity: VerifiedIdentity) => identity.userId === actor.userId && identity.email.toLowerCase() === actor.email.toLowerCase();
  const verified = await dependencies.reauthenticate(actor.email, input.currentPassword);
  if (!matchesActor(verified)) throw new PasswordChangeError('Your sign-in identity changed. Sign out and try again.');
  const current = await dependencies.currentMember();
  if (!current.active || !matchesActor(current)) throw new PasswordChangeError('Your account no longer has active workspace access.');
  const updated = await dependencies.update(input.password);
  if (!matchesActor(updated)) throw new PasswordChangeError('The password response could not be verified. Sign out and contact your owner.', 503);
}
