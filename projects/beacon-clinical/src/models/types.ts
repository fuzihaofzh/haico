export interface Site {
  id: string;
  name: string;
  region: string;
  timezone: string;
  created_at: string;
}

export interface Participant {
  id: string;
  site_id: string;
  external_id: string;
  initials: string;
  cohort: string | null;
  enrolled_at: string;
  status: 'screening' | 'active' | 'completed' | 'withdrawn' | 'discontinued';
}

export interface Visit {
  id: string;
  participant_id: string;
  site_id: string;
  visit_code: string;
  visit_label: string;
  scheduled_date: string;
  window_start: string;
  window_end: string;
  status: 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'missed' | 'cancelled';
  coordinator_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VisitProcedure {
  id: string;
  visit_id: string;
  procedure_code: string;
  procedure_name: string;
  requires_fasting: number;
  requires_consent: number;
  estimated_minutes: number;
  sort_order: number;
  completed: number;
}

export interface VisitPreparationSummary {
  visit: Visit;
  participant: Pick<Participant, 'id' | 'external_id' | 'initials' | 'cohort' | 'status'>;
  procedures: VisitProcedure[];
  preparation_checklist: PreparationItem[];
  total_estimated_minutes: number;
  alerts: string[];
}

export interface PreparationItem {
  label: string;
  required: boolean;
  category: 'consent' | 'fasting' | 'lab' | 'equipment' | 'general';
}

export interface AdverseEvent {
  id: string;
  participant_id: string;
  site_id: string;
  reported_by: string;
  reported_at: string;
  event_term: string;
  description: string;
  onset_date: string;
  severity: 'mild' | 'moderate' | 'severe' | 'life_threatening' | 'fatal';
  is_serious: number;
  causality: 'unrelated' | 'unlikely' | 'possible' | 'probable' | 'definite';
  status: 'open' | 'under_review' | 'escalated' | 'resolved' | 'closed';
  outcome: string | null;
  resolved_at: string | null;
  updated_at: string;
}

export interface AEEscalation {
  id: string;
  adverse_event_id: string;
  escalated_by: string;
  escalated_to: string;
  priority: 'standard' | 'urgent' | 'critical';
  reason: string;
  action_required: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface EscalationInboxItem {
  escalation: AEEscalation;
  adverse_event: AdverseEvent;
  participant: Pick<Participant, 'id' | 'external_id' | 'initials'>;
  site_name: string;
  days_open: number;
}

export interface EscalationInboxSummary {
  total: number;
  by_priority: { standard: number; urgent: number; critical: number };
  unacknowledged: number;
  items: EscalationInboxItem[];
}
