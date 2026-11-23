/** Clearly labelled, optional example records. No real customers or registration. */
import type { Customer, Lead, FollowUp, Quotation, WorkOrder, AuditEvent, LeadStatus, WorkspaceData } from './types.ts';
import { DEFAULT_COMPANY } from './types.ts';
import { computeQuote, todayIST, parseMoney } from './finance.ts';

export function createDemoData(now:Date = new Date()): Pick<WorkspaceData,'customers'|'leads'|'followups'|'quotations'|'workorders'|'activity'> {
  const today=todayIST(now);
  const day=(offset:number)=>new Date(new Date(today+'T00:00:00Z').getTime()+offset*86400000).toISOString().slice(0,10);
  const time=(offset:number,hour:string)=>new Date(`${day(offset)}T${hour}:00+05:30`).toISOString();
  const rows: {title:string;customer:string;contact:string;city:string;state:string;value:string;status:LeadStatus;owner:string;priority:'High'|'Medium'|'Low';source:string}[] = [
    {title:'Sharma residence',customer:'Sharma Family',contact:'Rohan Sharma',city:'Hisar',state:'06',value:'850000',status:'NEW',owner:'Amit',priority:'High',source:'Referral'},
    {title:'Verma duplex',customer:'Verma Family',contact:'Anita Verma',city:'Rohtak',state:'06',value:'590000',status:'NEW',owner:'Priya',priority:'Medium',source:'Website'},
    {title:'Greenfield office',customer:'Greenfield Studio',contact:'Disha Mehta',city:'Gurugram',state:'06',value:'1200000',status:'CONTACTED',owner:'Sameer',priority:'High',source:'Referral'},
    {title:'Apex warehouse',customer:'Apex Logistics',contact:'Arjun Bansal',city:'Manesar',state:'06',value:'1800000',status:'CONTACTED',owner:'Amit',priority:'Medium',source:'Website'},
    {title:'Gupta villa',customer:'Gupta Family',contact:'Nisha Gupta',city:'Panchkula',state:'06',value:'1620000',status:'SITE_VISIT',owner:'Priya',priority:'High',source:'Referral'},
    {title:'Kumar farmhouse',customer:'Kumar Family',contact:'Vivek Kumar',city:'Sonipat',state:'06',value:'2250000',status:'SITE_VISIT',owner:'Sameer',priority:'Medium',source:'Walk-in'},
    {title:'Sunrise interiors',customer:'Sunrise Associates',contact:'Neha Saini',city:'Hisar',state:'06',value:'430000',status:'QUOTED',owner:'Amit',priority:'Medium',source:'Instagram'},
    {title:'Metro retail fit-out',customer:'Metro Retail',contact:'Sahil Malhotra',city:'New Delhi',state:'07',value:'950000',status:'QUOTED',owner:'Priya',priority:'High',source:'Referral'},
    {title:'Northstar residence',customer:'Northstar Estates',contact:'Karan Arora',city:'Chandigarh',state:'04',value:'680000',status:'NEGOTIATION',owner:'Amit',priority:'High',source:'Website'},
    {title:'Hillview renovation',customer:'Hillview Homes',contact:'Meera Kapoor',city:'Gurugram',state:'06',value:'720000',status:'NEGOTIATION',owner:'Sameer',priority:'Low',source:'Referral'},
    {title:'DLF office upgrade',customer:'DLF Office Tenant',contact:'Rahul Goyal',city:'Gurugram',state:'06',value:'1440000',status:'WON',owner:'Sameer',priority:'High',source:'Referral'},
    {title:'Rosewood villa',customer:'Rosewood Family',contact:'Anjali Singh',city:'Hisar',state:'06',value:'1620000',status:'WON',owner:'Priya',priority:'Medium',source:'Website'},
    {title:'Metro warehouse',customer:'Metro Distribution',contact:'Ritesh Jain',city:'Manesar',state:'06',value:'1200000',status:'WON',owner:'Amit',priority:'Medium',source:'Referral'},
  ];
  const customers:Customer[]=rows.map((r,i)=>({id:`demo_customer_${i+1}`,name:r.customer,contact:r.contact,phone:'',email:`example${i+1}@example.com`,address:`Illustrative billing address, ${r.city}`,stateCode:r.state,gstin:'',isDemo:true,createdAt:time(-22+i,'09:00')}));
  const leads:Lead[]=rows.map((r,i)=>({id:`demo_lead_${i+1}`,customerId:customers[i].id,title:r.title,contact:r.contact,phone:'',email:customers[i].email,location:r.city,siteAddress:`Example project site, ${r.city}`,stateCode:r.state,value:parseMoney(r.value),status:r.status,source:r.source,owner:r.owner,priority:r.priority,notes:i===0?'Discuss a ground-floor renovation, waterproofing and finishes. Arrange a measurement visit.':'Illustrative project. Scope, quantities and rates are examples only.',lostReason:'',isDemo:true,createdAt:time(-22+i,'09:00'),updatedAt:time(-1,'16:00')}));
  const taskRows=[
    {lead:0,title:'Discuss the renovation estimate',hour:'10:00',offset:0,channel:'Call'},
    {lead:2,title:'Confirm measurements at Greenfield',hour:'11:30',offset:0,channel:'Site visit'},
    {lead:4,title:'Review BOQ and material choices',hour:'14:00',offset:0,channel:'Call'},
    {lead:6,title:'Follow up on the quotation',hour:'16:00',offset:0,channel:'WhatsApp'},
    {lead:7,title:'Check the fit-out approval timeline',hour:'17:30',offset:0,channel:'Email'},
    {lead:8,title:'Discuss the revised scope',hour:'15:00',offset:-1,channel:'Call'},
    {lead:1,title:'Book a first site visit',hour:'10:30',offset:1,channel:'Call'},
    {lead:9,title:'Send the finish options',hour:'12:00',offset:1,channel:'Email'},
  ];
  const followups:FollowUp[]=taskRows.map((r,i)=>({id:`demo_followup_${i+1}`,leadId:leads[r.lead].id,title:r.title,dueAt:time(r.offset,r.hour),channel:r.channel as FollowUp['channel'],owner:leads[r.lead].owner,notes:'Example follow-up. Update the outcome after your conversation.',status:'OPEN',outcome:'',isDemo:true,createdAt:time(-2,'10:00'),updatedAt:time(-2,'10:00')}));
  const supplier={...DEFAULT_COMPANY,name:'Example Construction Company',legalName:'Illustrative company — not a registered identity',address:'Illustrative supplier address, Haryana',stateCode:'06',gstin:''};
  const quotations:Quotation[]=[6,7,8,9,10,11,12].map((leadIndex,i)=>{
    const lead=leads[leadIndex];
    const rupees=lead.value/100;
    const priced=computeQuote([
      {id:`demo_item_${i+1}_1`,description:'Civil works and preparation — example scope',hsnSac:'9954',quantity:'1',unit:'job',unitPrice:(rupees*.65).toFixed(2),discount:'0',gstRate:'18'},
      {id:`demo_item_${i+1}_2`,description:'Finishes and installation — example scope',hsnSac:'9954',quantity:'1',unit:'job',unitPrice:(rupees*.35).toFixed(2),discount:'0',gstRate:'18'},
    ],'06',lead.stateCode);
    return {id:`demo_quote_${i+1}`,leadId:lead.id,number:`DEMO/Q/${String(i+21).padStart(3,'0')}`,title:lead.title,validUntil:day(14),placeOfSupply:lead.stateCode,siteAddress:lead.siteAddress,terms:'EXAMPLE ONLY. Rates and scope are illustrative. This is not a tax invoice.',items:priced.items,totals:priced.totals,status:i>=4?'ACCEPTED':'ISSUED',revision:1,supplier,customer:customers[leadIndex],issuedAt:time(-5,'12:00'),...(i>=4?{acceptedAt:time(-4,'11:00')}:{}),acceptanceNote:i>=4?'Illustrative acceptance for example work order.':'',isDemo:true,createdAt:time(-7,'10:00'),updatedAt:time(-4,'11:00')} as Quotation;
  });
  const workorders:WorkOrder[]=quotations.slice(4).map((q,i)=>({id:`demo_workorder_${i+1}`,quoteId:q.id,number:`DEMO/WO/${String(16+i).padStart(3,'0')}`,title:q.title,customerName:q.customer!.name,siteAddress:q.siteAddress,owner:['Sameer','Priya','Amit'][i],startDate:day(i===1?2:-8),endDate:day(16+i*7),status:i===1?'PLANNED':'ACTIVE',snapshot:structuredClone(q),milestones:[{id:`demo_milestone_${i}_1`,title:'Site preparation and measurements',dueDate:day(-6),status:i===1?'PENDING':'DONE',...(i===1?{}:{completedAt:time(-6,'17:00')})},{id:`demo_milestone_${i}_2`,title:'Complete civil works',dueDate:day(4),status:i===0?'DONE':'PENDING',...(i===0?{completedAt:time(-1,'16:00')}: {})},{id:`demo_milestone_${i}_3`,title:'Finishes and quality inspection',dueDate:day(12+i*2),status:'PENDING'},{id:`demo_milestone_${i}_4`,title:'Client walkthrough and handover',dueDate:day(16+i*7),status:'PENDING'}],isDemo:true,createdAt:time(-4,'11:00'),updatedAt:time(-1,'16:00')}));
  const activity:AuditEvent[]=[];
  return {customers,leads,followups,quotations,workorders,activity};
}
