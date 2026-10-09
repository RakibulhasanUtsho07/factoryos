export type AiAgentStudioTemplateCategory =
  | 'ORDER_RECOVERY'
  | 'PROCUREMENT'
  | 'QUALITY'
  | 'MAINTENANCE'
  | 'FINANCE'
  | 'EHS'
  | 'LOGISTICS';

export interface AiAgentStudioTemplate {
  key: string;
  version: string;
  category: AiAgentStudioTemplateCategory;
  title: string;
  description: string;
  goal: string;
  suggestedToolFamilies: readonly string[];
  steps: readonly string[];
  completionCriteria: readonly string[];
  guardrails: readonly string[];
}

export interface CreateAiAgentStudioTemplateDraftInput {
  title?: string | null;
  customization?: string | null;
}

export const AI_AGENT_STUDIO_TEMPLATES: readonly AiAgentStudioTemplate[] = [
  {
    key: 'order-recovery',
    version: '1.0.0',
    category: 'ORDER_RECOVERY',
    title: 'Order Recovery Assistant',
    description:
      'Investigate blocked, delayed, or at-risk customer orders and prepare a human-reviewable recovery plan.',
    goal:
      'Identify the current order blocker, affected milestones, responsible owner, and safe recovery options without changing the order.',
    suggestedToolFamilies: [
      'order status lookup',
      'inventory availability lookup',
      'production milestone lookup',
      'shipment tracking lookup',
    ],
    steps: [
      'Confirm the order identity and data freshness within the current factory scope.',
      'Summarize order, inventory, production, and shipment facts with their evidence sources.',
      'Identify the primary blocker and list alternative recovery options with trade-offs.',
      'Mark any customer commitment, allocation, cancellation, or dispatch decision for human approval.',
    ],
    completionCriteria: [
      'The blocker and supporting evidence are recorded.',
      'At least one feasible recovery option and its owner are identified, or an escalation is recommended.',
      'Unverified facts and approval points are clearly marked.',
    ],
    guardrails: [
      'Read-only recommendations only; do not edit orders, allocate inventory, cancel orders, dispatch shipments, or promise a delivery date.',
      'Do not invent stock, production, or carrier status when evidence is missing.',
    ],
  },
  {
    key: 'procurement-exception',
    version: '1.0.0',
    category: 'PROCUREMENT',
    title: 'Procurement Exception Assistant',
    description:
      'Triage replenishment and supplier exceptions and prepare a reviewable procurement recommendation.',
    goal:
      'Explain a purchasing or supplier exception and propose evidence-backed next steps without creating or approving a purchase order.',
    suggestedToolFamilies: [
      'inventory and reorder threshold lookup',
      'supplier status lookup',
      'purchase order status lookup',
      'goods receipt status lookup',
    ],
    steps: [
      'Check the inventory/reorder signal, open purchase orders, and available supplier evidence.',
      'Distinguish data gaps, lead-time risk, quantity variance, and supplier delay.',
      'Compare replenishment or supplier-follow-up options and identify cost/lead-time trade-offs.',
      'List the approvals and checks required before a buyer takes action.',
    ],
    completionCriteria: [
      'The exception is classified with evidence and freshness noted.',
      'Recommended next steps include an owner and required approval checkpoints.',
      'Price, quantity, supplier, and delivery assumptions are marked for verification.',
    ],
    guardrails: [
      'Do not create, amend, or approve purchase orders; do not onboard suppliers or change supplier master data.',
      'Never infer supplier commitments from an unverified recommendation.',
    ],
  },
  {
    key: 'quality-containment',
    version: '1.0.0',
    category: 'QUALITY',
    title: 'Quality Containment Assistant',
    description:
      'Organize defect and nonconformance evidence and propose containment and investigation steps.',
    goal:
      'Prepare an auditable quality triage and containment recommendation while leaving disposition and release decisions to authorized quality personnel.',
    suggestedToolFamilies: [
      'defect and nonconformance lookup',
      'lot genealogy lookup',
      'inspection result lookup',
      'quality hold status lookup',
    ],
    steps: [
      'Summarize defect observations, affected lots, inspection evidence, and known production context.',
      'Identify missing traceability and possible scope of impact without asserting an unverified root cause.',
      'Propose containment, sampling, investigation, and corrective-action options for quality review.',
      'Escalate potential product-safety or regulatory risk to the authorized quality/safety owner.',
    ],
    completionCriteria: [
      'Affected scope and evidence gaps are documented.',
      'Containment and investigation recommendations have named review checkpoints.',
      'No product-release or nonconformance-closure decision is made by the assistant.',
    ],
    guardrails: [
      'Do not release, scrap, rework, or close quality records; do not override deterministic quality controls.',
      'Safety or regulatory concerns require escalation to an authorized human owner.',
    ],
  },
  {
    key: 'maintenance-triage',
    version: '1.0.0',
    category: 'MAINTENANCE',
    title: 'Maintenance Triage Assistant',
    description:
      'Triage equipment symptoms and maintenance backlog into a human-reviewable next-action plan.',
    goal:
      'Summarize equipment condition and maintenance evidence, prioritize triage, and recommend a safe work-order path without controlling equipment.',
    suggestedToolFamilies: [
      'equipment status and telemetry lookup',
      'maintenance work-order lookup',
      'spare-parts availability lookup',
      'maintenance schedule lookup',
    ],
    steps: [
      'Collect reported symptoms, available approved telemetry, asset identity, and active work orders.',
      'Separate observed facts from suspected causes and note missing or stale signals.',
      'Recommend a triage priority, specialist, and possible work-order steps for review.',
      'Flag machine-safety or interlock signals for the designated maintenance/safety authority.',
    ],
    completionCriteria: [
      'Asset and reported condition are summarized with evidence timestamps.',
      'A recommended triage priority and responsible owner are identified.',
      'Any safety-critical uncertainty is escalated rather than resolved autonomously.',
    ],
    guardrails: [
      'Do not start/stop equipment, alter setpoints, bypass interlocks, or claim machine control authority.',
      'Only recommend a work order; do not submit or close one.',
    ],
  },
  {
    key: 'finance-invoice-review',
    version: '1.0.0',
    category: 'FINANCE',
    title: 'Finance Invoice Review Assistant',
    description:
      'Compare invoice, purchase, receipt, and payment evidence and identify discrepancies for finance review.',
    goal:
      'Prepare a controlled invoice exception summary and recommendation without posting entries or initiating payments.',
    suggestedToolFamilies: [
      'invoice record lookup',
      'purchase order and goods receipt lookup',
      'payment status lookup',
      'cost center lookup',
    ],
    steps: [
      'Check invoice identity and compare available purchase-order and receipt evidence.',
      'Classify price, quantity, tax, duplicate, or missing-document discrepancies where evidence permits.',
      'Summarize payment status and unresolved checks without disclosing unnecessary sensitive data.',
      'Route discrepancies and any payment-related decision to the authorized finance approver.',
    ],
    completionCriteria: [
      'Compared evidence and discrepancies are summarized.',
      'Unverified amounts or accounting assumptions are explicitly marked.',
      'A finance owner and approval checkpoint are identified for material exceptions.',
    ],
    guardrails: [
      'Do not post journal entries, release or initiate payments, modify bank details, or approve invoices.',
      'Minimize sensitive financial data in summaries and logs.',
    ],
  },
  {
    key: 'ehs-incident-triage',
    version: '1.0.0',
    category: 'EHS',
    title: 'EHS Incident Triage Assistant',
    description:
      'Structure safety/environmental incident facts, route escalation, and prepare a checklist for authorized responders.',
    goal:
      'Produce a cautious incident triage and escalation summary using approved procedures while preserving human and deterministic safety authority.',
    suggestedToolFamilies: [
      'incident record lookup',
      'approved hazard and procedure lookup',
      'corrective action status lookup',
      'escalation directory lookup',
    ],
    steps: [
      'Capture the incident description, location, time, reported hazards, and immediate status.',
      'Reference only approved response procedures and identify missing safety-critical facts.',
      'Recommend the appropriate escalation path and documentation checklist.',
      'Require the designated EHS/safety authority to confirm response and closure decisions.',
    ],
    completionCriteria: [
      'Incident facts and unknowns are separated clearly.',
      'Escalation recipient/role and evidence checklist are identified.',
      'No safety-critical control, incident dismissal, or closure is performed by the assistant.',
    ],
    guardrails: [
      'Do not dismiss or close incidents, direct machine control, or override emergency procedures.',
      'Immediate danger must follow the factory emergency procedure and authorized responder direction.',
    ],
  },
  {
    key: 'logistics-shipment-recovery',
    version: '1.0.0',
    category: 'LOGISTICS',
    title: 'Logistics Shipment Recovery Assistant',
    description:
      'Investigate delivery exceptions and organize evidence-backed recovery alternatives for dispatch/logistics review.',
    goal:
      'Identify shipment and delivery blockers and recommend recovery options without dispatching or changing customer commitments.',
    suggestedToolFamilies: [
      'shipment status lookup',
      'carrier tracking lookup',
      'dispatch plan lookup',
      'delivery exception lookup',
    ],
    steps: [
      'Verify shipment identity, current tracking status, and source timestamps.',
      'Summarize exception type, affected order/customer scope, and known operational constraints.',
      'Compare feasible recovery options and identify dependencies, risks, and required approvals.',
      'Route customer commitment or dispatch changes to the authorized logistics owner.',
    ],
    completionCriteria: [
      'Shipment exception and evidence sources are recorded.',
      'A recovery option or escalation path is recommended with an owner.',
      'Delivery promises and live dispatch changes remain subject to authorized review.',
    ],
    guardrails: [
      'Do not dispatch, reroute, cancel shipments, modify delivery commitments, or contact customers automatically.',
      'Treat carrier status as unverified if the approved source is missing or stale.',
    ],
  },
] as const;
