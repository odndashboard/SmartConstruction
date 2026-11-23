import type { ReactNode } from 'react';
import { Building2, HardHat, ShieldCheck } from 'lucide-react';

export default function AuthShell({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <main className="auth-page">
    <section className="auth-story" aria-label="smart construction">
      <a className="auth-brand" href="/login"><span><Building2 size={27} strokeWidth={1.6} /></span><strong>smart<small>construction</small></strong></a>
      <div className="auth-story-copy"><span className="auth-kicker">YOUR TEAM. YOUR WORKSPACE.</span><h1>Great projects start<br />with a clear plan<span>.</span></h1><p>From the first enquiry to the final handover, keep every next step in one place.</p><div className="auth-project-visual" aria-hidden="true"><div className="auth-visual-grid" /><HardHat size={60} strokeWidth={1.2} /><span>Built for the way you work</span></div></div>
      <div className="auth-story-footer"><span />Leads · Follow-ups · Quotations · Work orders</div>
    </section>
    <section className="auth-main"><div className="auth-card"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p className="auth-description">{description}</p>{children}<p className="auth-security"><ShieldCheck size={16} />Private access for your construction team</p></div><footer>smart construction <span>INR · GST enabled</span></footer></section>
  </main>;
}

export function SetupPending() {
  return <AuthShell eyebrow="YOUR WORKSPACE IS TAKING SHAPE" title="We’re getting things ready." description="The owner is connecting this workspace before opening access to the team."><div className="auth-note"><strong>For employees</strong><p>Your owner will share the website address and a private account setup link when the workspace is ready.</p></div></AuthShell>;
}
