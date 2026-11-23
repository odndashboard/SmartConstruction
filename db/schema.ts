import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check, index, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// One private company workspace per deployment. Authentication is platform-owned.
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  company: text('company_json').notNull(),
  sequences: text('sequences_json').notNull().default('{}'),
}, t => [check('workspace_singleton', sql`${t.id} = 1`), check('workspace_revision_positive', sql`${t.revision} >= 0`)]);

export const members = sqliteTable('members', {
  userId: text('user_id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(),
  role: text('role').notNull(), active: integer('active', { mode: 'boolean' }).notNull().default(true),
}, t => [check('member_role_valid', sql`${t.role} IN ('OWNER','MANAGER','SALES','OPERATIONS','VIEWER')`)]);

export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(), isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(), payload: text('payload_json').notNull(),
});
export const leads = sqliteTable('leads', {
  id: text('id').primaryKey(), customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
  status: text('status').notNull(), isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(), payload: text('payload_json').notNull(),
}, t => [index('lead_customer_idx').on(t.customerId), index('lead_status_idx').on(t.status)]);
export const followups = sqliteTable('followups', {
  id: text('id').primaryKey(), leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'restrict' }),
  status: text('status').notNull(), dueAt: text('due_at').notNull(),
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false), payload: text('payload_json').notNull(),
}, t => [index('followup_due_idx').on(t.status, t.dueAt), index('followup_lead_idx').on(t.leadId)]);
export const quotations = sqliteTable('quotations', {
  id: text('id').primaryKey(), leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'restrict' }),
  number: text('number'), status: text('status').notNull(),
  revisionOf: text('revision_of').references((): AnySQLiteColumn => quotations.id, { onDelete: 'restrict' }),
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false), payload: text('payload_json').notNull(),
}, t => [uniqueIndex('quotation_number_unique').on(t.number), uniqueIndex('quotation_revision_unique').on(t.revisionOf), index('quotation_lead_idx').on(t.leadId)]);
export const workorders = sqliteTable('workorders', {
  id: text('id').primaryKey(), quoteId: text('quote_id').notNull().references(() => quotations.id, { onDelete: 'restrict' }),
  number: text('number').notNull(), status: text('status').notNull(),
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false), payload: text('payload_json').notNull(),
}, t => [uniqueIndex('workorder_quote_unique').on(t.quoteId), uniqueIndex('workorder_number_unique').on(t.number), index('workorder_status_idx').on(t.status)]);
export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(), actorId: text('actor_id').references(() => members.userId, { onDelete: 'restrict' }),
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(), payload: text('payload_json').notNull(),
}, t => [index('audit_created_idx').on(t.createdAt)]);
export const mutationReceipts = sqliteTable('mutation_receipts', {
  requestId: text('request_id').primaryKey(), userId: text('user_id').notNull().references(() => members.userId, { onDelete: 'restrict' }),
  action: text('action').notNull(), payloadHash: text('payload_hash').notNull(),
  revision: integer('revision').notNull(), message: text('message').notNull(), createdAt: text('created_at').notNull(),
});
// INSERT a failing guard first in a D1 batch to roll the entire mutation back.
// Successful batches remove this row before committing; no request-time DDL.
export const mutationGuards = sqliteTable('mutation_guards', {
  id: text('id').primaryKey(), ok: integer('ok').notNull(),
}, t => [check('workspace_revision_matches', sql`${t.ok} = 1`)]);
