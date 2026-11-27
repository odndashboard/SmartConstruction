import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/supabase/config';
import { readAuthInput, authResponse, authError, databaseError } from '@/lib/auth-http';
import { getWorkspace, CRMError } from '@/lib/server';
import type { WorkspaceData } from '@/lib/types';
import { accountSetupLink } from '@/lib/auth-policy';

export const dynamic = 'force-dynamic';
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), name: z.string().trim().min(1, 'Enter the employee name.').max(200), email: z.string().trim().email('Enter a valid email address.').max(254).transform(v => v.toLowerCase()), role: z.enum(['MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER']) }).strict(),
  z.object({ action: z.literal('access_link'), userId: z.string().uuid() }).strict(),
]);

function requireOwner(data: WorkspaceData): void {
  if (!data.user.active || data.user.role !== 'OWNER') throw new CRMError('Only workspace owners can manage employee accounts.', 403);
}

export async function POST(request: Request) {
  try {
    const input = await readAuthInput(request, schema);
    const before = await getWorkspace();
    requireOwner(before);
    const admin = createAdminClient();
    let targetId: string;
    let hash: string;
    let type: 'invite' | 'recovery';

    if (input.action === 'add') {
      if (before.members.some(m => m.email.toLowerCase() === input.email)) {
        throw new CRMError('This person already has a team record. Use Reset password for an active employee, or restore their access from Removed accounts.', 409);
      }
      const { data, error } = await admin.auth.admin.generateLink({ type: 'invite', email: input.email, options: { data: { name: input.name } } });
      if (error || !data.user || !data.properties?.hashed_token) {
        throw new CRMError('An account setup link could not be created. Check the email address. If this account already exists in Supabase, ask your administrator to link it to the workspace.', 400);
      }
      if (data.user.email?.toLowerCase() !== input.email) throw new CRMError('The account email did not match. No workspace access was granted.', 409);
      targetId = data.user.id; hash = data.properties.hashed_token; type = 'invite';
      // This transaction rechecks the current owner and serializes membership
      // creation. An orphan Auth invite cannot read CRM data without membership.
      const added = await admin.rpc('crm_add_member', { p_actor_id: before.user.userId, p_user_id: targetId, p_name: input.name, p_email: input.email, p_role: input.role });
      if (added.error) throw databaseError(added.error.code);
    } else {
      if (input.userId === before.user.userId) throw new CRMError('Change your own password in Settings → Account security.', 403);
      const member = before.members.find(m => m.userId === input.userId);
      if (!member || !member.active) throw new CRMError('Enable this team member before creating an account link.', 403);
      const authorized = await admin.rpc('crm_authorize_member_link', { p_actor_id: before.user.userId, p_user_id: member.userId });
      if (authorized.error) throw databaseError(authorized.error.code);
      const { data: userData, error: userError } = await admin.auth.admin.getUserById(member.userId);
      if (userError || !userData.user || userData.user.email?.toLowerCase() !== member.email.toLowerCase()) {
        throw new CRMError('The account email has changed. Ask your administrator to review this member before resetting access.', 409);
      }
      type = userData.user.email_confirmed_at ? 'recovery' : 'invite';
      const { data, error } = await admin.auth.admin.generateLink({ type, email: member.email });
      if (error || !data.properties?.hashed_token || data.user?.id !== member.userId) throw new CRMError('The account link could not be created. Please try again.', 503);
      targetId = member.userId; hash = data.properties.hashed_token;
    }

    // A Supabase Auth call is outside the database transaction. Recheck after
    // it returns, before disclosing any token, if an owner or target was disabled.
    const after = await getWorkspace();
    requireOwner(after);
    const target = after.members.find(m => m.userId === targetId && m.active);
    if (!target) throw new CRMError('This person no longer has active workspace access. No account link was returned.', 403);
    return authResponse({ data: after, link: accountSetupLink(appOrigin(), hash, type), email: target.email, message: 'Private account link created. Copy it and share it directly with this employee. No email has been sent.' });
  } catch (error) { return authError(error); }
}
