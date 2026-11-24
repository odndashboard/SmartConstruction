import { LoaderCircle } from 'lucide-react';

export default function LoadingWorkspace() {
  return <div className="boot-screen" role="status">
    <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 44 44" fill="none"><path d="M6 35V17L18 9v26M18 35V5l20 10v20M25 14v21M31 18v17M6 35h32" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /><path d="M10 21h4m-4 6h4" stroke="currentColor" strokeWidth="2" /></svg></span>
    <h1>Opening your workspace</h1><p>Getting your latest records ready</p><LoaderCircle className="spin" size={23} />
  </div>;
}
