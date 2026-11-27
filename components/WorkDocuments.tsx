'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, Files } from 'lucide-react';
import type { WorkOrder } from '@/lib/types';
import { DOCUMENT_KEYS, DOCUMENT_NAMES, type DocumentStatus, type WorkDocumentKey } from '@/lib/work-documents';
import styles from './WorkDocuments.module.css';

interface Props {
  item: WorkOrder;
  editable: boolean;
  busy: boolean;
  statusAction?: ReactNode;
  onChange: (document: WorkDocumentKey, status: DocumentStatus) => void;
}

export default function WorkDocuments({ item, editable, busy, onChange, statusAction }: Props) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  return <>
    <div className={styles.actions}><button type="button" className="button button-secondary button-small" aria-expanded={expanded} aria-controls={panelId}
      onClick={() => setExpanded(!expanded)}><Files size={15} />Documents<ChevronDown size={13} className={expanded ? styles.up : undefined} /></button>{statusAction}</div>
    {expanded && <section id={panelId} aria-label={`Documents for ${item.number}`} className={styles.panel}>
      {DOCUMENT_KEYS.map(key => {
        const status = item.paperDocuments?.[key] ?? 'PENDING';
        return <div className={styles.row} key={key}><span>{DOCUMENT_NAMES[key]}</span>
          {editable ? <div className={styles.choices} role="group" aria-label={DOCUMENT_NAMES[key]}>
            {(['PENDING', 'RECEIVED'] as const).map(value => <button type="button" key={value} disabled={busy} aria-pressed={status === value} data-value={value}
              onClick={() => { if (status !== value) onChange(key, value); }}>{value === 'PENDING' ? 'Pending' : 'Received'}</button>)}
          </div> : <strong className={styles.status} data-value={status}>{status === 'RECEIVED' ? 'Received' : 'Pending'}</strong>}
        </div>;
      })}
    </section>}
  </>;
}
