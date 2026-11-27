import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const key = Symbol.for('crm.account-entry-test');
const fixture = "globalThis[Symbol.for('crm.account-entry-test')]";
const url = source => 'data:text/javascript,' + encodeURIComponent(source);
const modules = {
  'server-only': url('export {};'),
  '@/lib/server': url(`export { CRMError } from ${JSON.stringify(new URL('../lib/server-actions.ts', import.meta.url).href)};
    export async function getAccountMember() { const f=${fixture}; f.calls.push('member'); if(f.failure) throw f.failure; return f.member; }`),
  '@/lib/supabase/server': url(`export async function createAuthClient() { return {auth:${fixture}.auth}; }`),
  '@/lib/password-setup': url(`export async function clearPasswordSetup() {}
    export async function grantPasswordSetup(_client,id) { ${fixture}.calls.push(['grant',id]); }
    export async function requirePasswordSetup(_client,id) { ${fixture}.calls.push(['require',id]); }`),
};
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (Object.hasOwn(modules,spec)) return {url:modules[spec],shortCircuit:true};
  if (spec.startsWith('@/')) return next(new URL(spec.slice(2)+'.ts', root).href,ctx);
  if (spec.startsWith('.') && ctx.parentURL?.startsWith(root.href) && !ctx.parentURL.includes('/node_modules/')) {
    const target=new URL(spec+'.ts',ctx.parentURL);
    if(existsSync(fileURLToPath(target))) return next(target.href,ctx);
  }
  return next(spec,ctx);
}});
const login=(await import('../app/api/auth/login/route.ts')).POST;
const confirm=(await import('../app/api/auth/confirm/route.ts')).POST;
const password=(await import('../app/api/auth/password/route.ts')).POST;
const { CRMError } = await import('../lib/server-actions.ts');
const origin='https://crm.example.invalid';
const previous=process.env.APP_URL;
process.env.APP_URL=origin;
after(()=>{hooks.deregister(); delete globalThis[key]; if(previous===undefined) delete process.env.APP_URL; else process.env.APP_URL=previous;});
function setup(role) {
  const calls=[];
  const auth=Object.fromEntries(['signInWithPassword','signOut','verifyOtp','updateUser'].map(name=>[name,async()=>{calls.push(name);return {error:null};}]));
  return globalThis[key]={calls,auth,member:{userId:crypto.randomUUID(),role,active:true}};
}
function request(path,body) {
  return new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
}
test('login chooses the dealer portal or staff dashboard using live membership',async()=>{
  for(const [role,destination] of [['DEALER','/dealer'],['ACCOUNTANT','/']]) {
    const state=setup(role);
    const res=await login(request('/api/auth/login',{email:'member@example.invalid',password:'fixture-only'}));
    assert.equal(res.status,200); assert.equal((await res.json()).redirect,destination);
    assert.deepEqual(state.calls,['signInWithPassword','member']);
  }
});
test('a dealer can activate their invitation and set their password without loading the staff workspace',async()=>{
  const f=setup('DEALER');
  const linked=await confirm(request('/api/auth/confirm',{type:'invite',token_hash:'test-only-invite-token-1234'}));
  assert.equal(linked.status,200); assert.equal((await linked.json()).redirect,'/set-password');
  const value='Fixture Password 2468!!';
  const saved=await password(request('/api/auth/password',{password:value,confirmPassword:value}));
  assert.equal(saved.status,200);assert.equal((await saved.json()).redirect,'/dealer');
  assert.deepEqual(f.calls,['verifyOtp','member',['grant',f.member.userId],'member',['require',f.member.userId],'updateUser']);
});
test('a successful password match with disabled membership clears the session',async()=>{
  const f=setup('DEALER'); f.failure=new CRMError('Account disabled',403);
  const res=await login(request('/api/auth/login',{email:'member@example.invalid',password:'fixture-only'}));
  assert.equal(res.status,403);assert.deepEqual(f.calls,['signInWithPassword','member','signOut']);
});
