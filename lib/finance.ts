import type { QuoteItemInput, QuoteItem, QuoteTotals, TaxMode, PackagePricing } from './types';
import { MAX_QUOTE_ITEMS } from './quotation-categories.ts';

export const STATE_OPTIONS = [
  {value:'01',label:'Jammu and Kashmir'}, {value:'02',label:'Himachal Pradesh'},
  {value:'03',label:'Punjab'}, {value:'04',label:'Chandigarh'}, {value:'05',label:'Uttarakhand'},
  {value:'06',label:'Haryana'}, {value:'07',label:'Delhi'}, {value:'08',label:'Rajasthan'},
  {value:'09',label:'Uttar Pradesh'}, {value:'10',label:'Bihar'}, {value:'11',label:'Sikkim'},
  {value:'12',label:'Arunachal Pradesh'}, {value:'13',label:'Nagaland'}, {value:'14',label:'Manipur'},
  {value:'15',label:'Mizoram'}, {value:'16',label:'Tripura'}, {value:'17',label:'Meghalaya'},
  {value:'18',label:'Assam'}, {value:'19',label:'West Bengal'}, {value:'20',label:'Jharkhand'},
  {value:'21',label:'Odisha'}, {value:'22',label:'Chhattisgarh'}, {value:'23',label:'Madhya Pradesh'},
  {value:'24',label:'Gujarat'}, {value:'26',label:'Dadra and Nagar Haveli and Daman and Diu'},
  {value:'27',label:'Maharashtra'}, {value:'29',label:'Karnataka'}, {value:'30',label:'Goa'},
  {value:'31',label:'Lakshadweep'}, {value:'32',label:'Kerala'}, {value:'33',label:'Tamil Nadu'},
  {value:'34',label:'Puducherry'}, {value:'35',label:'Andaman and Nicobar Islands'},
  {value:'36',label:'Telangana'}, {value:'37',label:'Andhra Pradesh'}, {value:'38',label:'Ladakh'},
];
const STATE_CODES = new Set(STATE_OPTIONS.map(state=>state.value));
const UTGST = new Set(['04','26','31','35','38']);
export const MAX_PAISE = 9_000_000_000_000;
const MAX = BigInt(MAX_PAISE);
// Locale settings are reusable; no dates, amounts or private records are cached.
const INDIA_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'});
const INR_FORMAT = new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:0,maximumFractionDigits:2});

function scaled(value: string, places: number, label: string): bigint {
  if (typeof value !== 'string' || value.length > 30) throw new Error(`${label} must be a decimal value.`);
  const clean = value.trim();
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`);
  if (!pattern.test(clean)) throw new Error(`${label} must be non-negative, with no more than ${places} decimal places.`);
  const [whole, fraction=''] = clean.split('.');
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places,'0'));
}
function bounded(value: bigint, label='Amount'): number {
  if (value < 0n || value > MAX) throw new Error(`${label} exceeds the supported limit.`);
  return Number(value);
}
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}
export function parseMoney(value: string): number { return bounded(scaled(value,2,'Amount')); }

export function todayIST(date: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date.');
  const parts = INDIA_DATE_FORMAT.formatToParts(date);
  const get = (type:string)=>parts.find(p=>p.type===type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function financialYear(date: Date|string = new Date()): string {
  const day = typeof date === 'string' ? date : todayIST(date);
  const parsed = new Date(day+'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10)!==day) throw new Error('Invalid financial-year date.');
  const year = Number(day.slice(0,4))-(Number(day.slice(5,7))<4?1:0);
  return `${year}-${String(year+1).slice(-2)}`;
}
export function validateRegistration(gstin: string, stateCode: string, required = false): void {
  if (!gstin) { if (required) throw new Error('Add the company GSTIN in Settings before issuing a quotation.'); return; }
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) || !STATE_CODES.has(gstin.slice(0,2))) throw new Error('Enter a valid uppercase 15-character GSTIN.');
  if (!STATE_CODES.has(stateCode) || gstin.slice(0,2)!==stateCode) throw new Error('GSTIN prefix must match the registration state.');
}
export function getTaxMode(supplierState:string, placeOfSupply:string): TaxMode {
  if (supplierState && !STATE_CODES.has(supplierState)) throw new Error('Choose a valid supplier registration state.');
  if (placeOfSupply && !STATE_CODES.has(placeOfSupply)) throw new Error('Choose a valid project place of supply.');
  if (!supplierState || !placeOfSupply) return 'UNCONFIGURED';
  if (supplierState !== placeOfSupply) return 'IGST';
  return UTGST.has(supplierState)?'CGST_UTGST':'CGST_SGST';
}
function taxes(taxable: bigint, rate: bigint, mode: TaxMode) {
  const split = mode === 'CGST_SGST' || mode === 'CGST_UTGST';
  const cgst = split ? roundHalfUp(taxable * rate, 20000n) : 0n;
  const sgst = mode === 'CGST_SGST' ? cgst : 0n;
  const utgst = mode === 'CGST_UTGST' ? cgst : 0n;
  const igst = mode === 'IGST' ? roundHalfUp(taxable * rate, 10000n) : 0n;
  return { cgst, sgst, utgst, igst, total: taxable + cgst + sgst + utgst + igst };
}

export function computeQuote(inputs: QuoteItemInput[], supplierState: string, placeOfSupply: string, gstEnabled = true, pricing?: PackagePricing): {items:QuoteItem[];totals:QuoteTotals} {
  if (!Array.isArray(inputs) || inputs.length>MAX_QUOTE_ITEMS) throw new Error(`A quotation supports up to ${MAX_QUOTE_ITEMS} work items.`);
  const configuredMode = getTaxMode(supplierState,placeOfSupply);
  const mode: TaxMode = gstEnabled ? configuredMode : 'NO_GST';
  const sums = {subtotal:0n,discount:0n,taxable:0n,cgst:0n,sgst:0n,utgst:0n,igst:0n,total:0n};
  const items = inputs.map((input, index) => {
    const prefix=`Item ${index+1}`;
    const quantity=scaled(input.quantity,3,`${prefix} quantity`);
    const price=scaled(input.unitPrice,2,`${prefix} unit price`);
    const discount=scaled(input.discount === '' ? '0' : input.discount,2,`${prefix} discount`);
    const rate=scaled(!gstEnabled && input.gstRate === '' ? '0' : input.gstRate,2,`${prefix} GST rate`);
    if (pricing && (price !== 0n || discount !== 0n || rate !== 0n)) throw new Error('Enter price and GST once for the package.');
    if (quantity<=0n || quantity>1_000_000_000_000n) throw new Error(`${prefix} quantity must be positive and within the supported limit.`);
    if (rate>10000n) throw new Error(`${prefix} GST rate must be between 0 and 100%.`);
    if (!gstEnabled && rate !== 0n) throw new Error(`${prefix} has a GST rate. Apply GST or set the rate to zero.`);
    bounded(price,`${prefix} unit price`);
    const gross=roundHalfUp(quantity*price,1000n);
    bounded(gross,`${prefix} gross value`);
    if (discount>gross) throw new Error(`${prefix} discount cannot exceed its gross value.`);
    const taxable=gross-discount;
    const { cgst, sgst, utgst, igst, total } = taxes(taxable, rate, mode);
    sums.subtotal+=gross;sums.discount+=discount;sums.taxable+=taxable;
    sums.cgst+=cgst;sums.sgst+=sgst;sums.utgst+=utgst;sums.igst+=igst;sums.total+=total;
    return {...input,...(!gstEnabled ? {gstRate:'0'} : {}),gross:bounded(gross),taxable:bounded(taxable),cgst:bounded(cgst),sgst:bounded(sgst),utgst:bounded(utgst),igst:bounded(igst),total:bounded(total)};
  });
  if (pricing) {
    const price = scaled(pricing.packagePrice, 2, 'Package price');
    const rate = scaled(pricing.packageGstRate, 2, 'Package GST rate');
    bounded(price, 'Package price');
    if (rate > 10000n) throw new Error('Package GST rate must be between 0 and 100%.');
    if (!gstEnabled && rate !== 0n) throw new Error('Apply GST or set the package GST rate to zero.');
    Object.assign(sums, { subtotal: price, taxable: price }, taxes(price, rate, mode));
  }
  const amounts = Object.fromEntries(Object.entries(sums).map(([key,value])=>[key,bounded(value,'Quotation total')])) as Omit<QuoteTotals,'mode'|'needsConfig'>;
  return {items,totals:{...amounts,mode,needsConfig:mode==='UNCONFIGURED'}};
}
export function formatINR(paise: number, compact=false): string {
  if (!Number.isFinite(paise)) return '₹0';
  const rupees=paise/100;
  if(compact && Math.abs(rupees)>=10000000) return `₹${(rupees/10000000).toFixed(2).replace(/\.00$/,'')}Cr`;
  if(compact && Math.abs(rupees)>=100000) return `₹${(rupees/100000).toFixed(1).replace(/\.0$/,'')}L`;
  return INR_FORMAT.format(rupees);
}
