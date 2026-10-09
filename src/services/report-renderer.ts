import type { AppConfig } from '../types/index.ts';
import type { InvestigationResult, TriageResult, TriageRoute } from './triage-schemas.ts';

const CLASSIFICATION_LABEL: Record<TriageResult['classification'], string> = {
  bug: 'Bug',
  investigation: 'Investigation',
  feature_request: 'Feature request',
  question: 'Question',
  config_or_data: 'Configuration or data',
  not_a_bug: 'Not a bug',
};

const VALIDITY_LABEL: Record<InvestigationResult['validity'], string> = {
  valid: 'Yes',
  invalid: 'No',
  uncertain: 'Uncertain',
};

function workItemLink(config: AppConfig, id: number): string {
  return `${config.orgUrl}/${encodeURIComponent(config.project)}/_workitems/edit/${id}`;
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

/**
 * The comment posted on the work item, as markdown, built from the agents'
 * structured output so its layout never depends on how the model phrased it.
 */
export function renderTriageReport(
  config: AppConfig,
  triage: TriageResult,
  route: TriageRoute,
  investigation?: InvestigationResult,
): string {
  const header = [CLASSIFICATION_LABEL[triage.classification], `severity: ${triage.severityGuess}`];
  if (triage.area) header.push(`area: ${triage.area}`);

  const out: string[] = [
    '### Triage',
    `**${header.join(' · ')}**`,
    '',
    triage.summary,
  ];

  if (route === 'needs_info') {
    out.push('', '### Questions for the reporter', 'The agent needs answers before it can investigate:', '', bullets(triage.questionsForReporter));
    if (triage.missingInfo.length > 0) out.push('', '**Missing:**', bullets(triage.missingInfo));
  }

  if (triage.duplicates.length > 0) {
    out.push('', route === 'duplicate' ? '### Possible duplicate' : '### Related work items');
    out.push(bullets(triage.duplicates.map((d) =>
      `[#${d.id} ${d.title}](${workItemLink(config, d.id)}) (${d.confidence} confidence): ${d.reason}`)));
  }

  if (route !== 'investigate' && route !== 'needs_info') {
    out.push('', `*Not investigated in the code: ${triage.rationale}*`);
  }

  if (investigation) {
    out.push(
      '',
      '### Bug Validity',
      `${VALIDITY_LABEL[investigation.validity]} (${investigation.confidence} confidence)`,
      '',
      '### Root Cause',
      investigation.rootCause,
    );
    if (investigation.codeReferences.length > 0) {
      out.push('', '### Code References', bullets(investigation.codeReferences.map((r) =>
        `\`${r.path}${r.line !== null ? `:${r.line}` : ''}\`${r.note ? `: ${r.note}` : ''}`)));
    }
    if (investigation.reproduction.length > 0) {
      out.push('', '### Reproduction', investigation.reproduction.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    }
    out.push('', '### Suggested Fix', investigation.suggestedFix);
    if (investigation.risks) out.push('', '### Risks', investigation.risks);
    out.push('', '### Ambiguities & Doubts',
      investigation.ambiguities.length > 0 ? bullets(investigation.ambiguities) : 'None identified.');
  }

  return out.join('\n');
}
