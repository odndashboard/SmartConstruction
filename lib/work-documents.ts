export const DOCUMENT_KEYS = ['electricityBill', 'registrationAllotment', 'photo', 'aadhaarCard', 'panCard', 'bankPassbook', 'gmailId'] as const;
export type WorkDocumentKey = typeof DOCUMENT_KEYS[number];
export type DocumentStatus = 'PENDING' | 'RECEIVED';
export const DOCUMENT_NAMES: Record<WorkDocumentKey, string> = {
  electricityBill: 'Electricity Bill',
  registrationAllotment: 'Registration / Allotment',
  photo: 'Photo',
  aadhaarCard: 'Aadhaar Card',
  panCard: 'PAN Card',
  bankPassbook: 'Bank passbook',
  gmailId: 'Gmail ID',
};
