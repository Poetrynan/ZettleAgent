import { invoke } from '@tauri-apps/api/core';

export interface ResearchProject {
  id: string;
  title: string;
  question: string;
  scope: string;
  status: 'active' | 'paused' | 'completed' | string;
  version: number;
  source_paths: string[];
  claim_ids: string[];
  unresolved_questions: string[];
  next_steps: string[];
  artifact_paths: string[];
  created_at_ms: number;
  updated_at_ms: number;
  claims?: Claim[];
}

export interface ClaimEvidence {
  id: string;
  role: 'supports' | 'contradicts' | 'source' | string;
  confidence: number;
  source_type: string;
  source_id: string;
  locator?: string;
  excerpt?: string;
  checksum?: string;
  captured_at_ms?: number;
}

export interface Claim {
  id: string;
  title: string;
  content: string;
  conditions: string;
  status: 'proposed' | 'confirmed' | 'disputed' | 'superseded' | string;
  version: number;
  project_id?: string;
  valid_from_ms?: number | null;
  valid_to_ms?: number | null;
  evidence: ClaimEvidence[];
  created_at_ms: number;
  updated_at_ms: number;
}

export interface EvidenceInput {
  path: string;
  quote?: string;
  quote_kind?: 'original' | 'translation' | 'paraphrase';
  role: 'supports' | 'contradicts' | 'source';
  locator?: string;
  expected_checksum?: string;
}

export interface SourceSegment {
  content: string;
  locator: string;
  start_line?: number;
  end_line?: number;
  page?: number;
  page_label?: string | null;
  needs_ocr?: boolean;
}

export interface SourceReadResult {
  path: string;
  source_id: string;
  source_checksum: string;
  kind: string;
  locator: string;
  segments: SourceSegment[];
  truncated: boolean;
  total_lines?: number;
  total_pages?: number;
  next_start_line?: number;
  next_start_page?: number;
}

export interface QuoteMatch {
  excerpt: string;
  locator: string;
  start_line?: number;
  end_line?: number;
  page?: number;
  page_label?: string | null;
}

export interface QuoteVerifyResult {
  path: string;
  source_checksum: string;
  status: 'exact' | 'normalized' | 'approximate' | 'not_found' | 'unavailable';
  verified: boolean;
  quote_kind: 'original' | 'translation' | 'paraphrase';
  reason?: string;
  matches: QuoteMatch[];
  truncated?: boolean;
  next_start_line?: number;
}

export interface SourceCaptureResult {
  source_id: string;
  path: string;
  original_path: string;
  source_checksum: string;
  reused: boolean;
  title: string;
  changeset_ids: string[];
}

export interface ClaimTraceResult {
  claim: Claim;
  supporting_evidence: ClaimEvidence[];
  opposing_evidence: ClaimEvidence[];
  source_evidence: ClaimEvidence[];
  dependencies: Array<{ source: string; target: string; relation_type: string; confidence: number }>;
  has_explicit_evidence: boolean;
}

export interface ImpactPreviewResult {
  target: string;
  affected_claims: Array<{ id: string; title: string; evidence_role?: string }>;
  affected_projects: Array<{ id: string; title: string }>;
  affected_notes: Array<{ id?: string; path?: string; relation: string }>;
  total_impacted: number;
  requires_review: boolean;
}

export interface ReviewDraftItem {
  card_id: string;
  claim_id?: string;
  project_id?: string;
  question: string;
  answer: string;
  locators?: string[];
  status: string;
}

// ── IPC wrappers ────────────────────────────────────────────────────────────

export async function researchAction<T = unknown>(
  vaultPath: string,
  action: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  return invoke<T>('research_action', { vaultPath, action, args });
}

export async function researchReadSource(
  vaultPath: string,
  request: Record<string, unknown>
): Promise<SourceReadResult> {
  return invoke<SourceReadResult>('research_read_source', { vaultPath, request });
}

export async function researchVerifyQuote(
  vaultPath: string,
  request: Record<string, unknown>
): Promise<QuoteVerifyResult> {
  return invoke<QuoteVerifyResult>('research_verify_quote', { vaultPath, request });
}

export async function researchCaptureSource(
  vaultPath: string,
  request: Record<string, unknown>
): Promise<SourceCaptureResult> {
  return invoke<SourceCaptureResult>('research_capture_source', { vaultPath, request });
}
