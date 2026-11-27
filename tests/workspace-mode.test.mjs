import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { WORKSPACE_MODE_COOKIE, workspaceMode } from '../lib/workspace-mode.ts';

const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const nativeRequire = createRequire(import.meta.url);
const CRMApp = () => null;
class CRMError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
function home(mode, failure) {
  const calls = [];
  const workspace = { revision: 3, leads: [], user: { active: true, role: 'SALES' } };
  const exports = {};
  const modules = {
    '../components/CRMApp': { default: CRMApp },
    'next/navigation': { redirect(url) { throw new Error('Redirect ' + url); } },
    'next/headers': { cookies: async () => ({ get: name => name === WORKSPACE_MODE_COOKIE && { value: mode } }) },
    '@/lib/workspace-mode': { WORKSPACE_MODE_COOKIE, workspaceMode },
    '@/lib/initial-workspace': { async getInitialWorkspace() {
      calls.push('dashboard'); if (failure) throw failure;
      return { workspace, operations: { revision: 10 }, operationsError: '' };
    } },
    '@/lib/server': { async getWorkspace() { calls.push('workspace'); if (failure) throw failure; return workspace; } },
    '@/lib/supabase/config': { isWorkspaceConfigured: () => true },
    '@/lib/server-actions': { CRMError },
    '@/components/AuthShell': { SetupPending: () => null },
  };
  new Function('require', 'exports', compiled)(id => modules[id] ?? nativeRequire(id), exports);
  return { render: exports.default, calls, workspace };
}

test('simple preference loads the authorized workspace without fetching advanced summaries', async () => {
  const { render, calls, workspace } = home('simple');
  const element = await render();
  assert.equal(element.type, CRMApp);
  assert.equal(element.props.initialMode, 'simple');
  assert.equal(element.props.initialWorkspace, workspace);
  assert.equal(element.props.initialOperations, null);
  assert.deepEqual(calls, ['workspace']);
});

test('advanced, missing and unrecognized preferences use the full dashboard', async () => {
  for (const mode of ['advanced', undefined, 'other']) {
    const { render, calls } = home(mode);
    const { props } = await render();
    assert.equal(props.initialMode, 'advanced');
    assert.deepEqual(props.initialOperations, { revision: 10 });
    assert.deepEqual(calls, ['dashboard']);
  }
});

test('switching the presentation never bypasses sign-in or dealer routing', async () => {
  for (const mode of ['simple', 'advanced']) {
    await assert.rejects(home(mode, new CRMError('Sign in', 401)).render, /Redirect \/login/);
    await assert.rejects(home(mode, new CRMError('Use the dealer lead portal.', 403)).render, /Redirect \/dealer/);
    const result = await home(mode, new Error('Offline')).render();
    assert.equal(result.props.initialWorkspace, undefined);
    assert.equal(result.props.initialMode, mode);
    assert.match(result.props.initialError, /could not be loaded/);
  }
});

test('printing a quotation in either mode hides the workspace and other customer records', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const print = css.slice(css.indexOf('@media print'));
  const hidden = print.match(/([^{}]+)\{display:none!important\}/)?.[1].split(',') ?? [];
  for (const selector of ['.crm-app', '.simple-app', '.modal-layer', '.toast']) assert.ok(hidden.includes(selector));
  assert.match(print, /\.print-target\{display:block!important/);
});
