/**
 * The default workflow library (docs/WORKFLOWS.md, "Default workflows"),
 * embedded as text so the compiled binary carries them.
 */
/// <reference path="../assets.d.ts" />
import reviewChanges from './review-changes.js' with { type: 'text' };
import deepResearch from './deep-research.js' with { type: 'text' };
import researchSweep from './research-sweep.js' with { type: 'text' };
import planImplementVerify from './plan-implement-verify.js' with { type: 'text' };
import fixUntilGreen from './fix-until-green.js' with { type: 'text' };
import fixIssue from './fix-issue.js' with { type: 'text' };
import bugHunt from './bug-hunt.js' with { type: 'text' };
import securityAudit from './security-audit.js' with { type: 'text' };
import designPanel from './design-panel.js' with { type: 'text' };
import uiPass from './ui-pass.js' with { type: 'text' };
import migrate from './migrate.js' with { type: 'text' };
import compareHarnesses from './compare-harnesses.js' with { type: 'text' };

export interface DefaultWorkflow {
  file: string;
  script: string;
}

export const DEFAULT_WORKFLOWS: DefaultWorkflow[] = [
  { file: 'review-changes.js', script: reviewChanges },
  { file: 'deep-research.js', script: deepResearch },
  { file: 'research-sweep.js', script: researchSweep },
  { file: 'plan-implement-verify.js', script: planImplementVerify },
  { file: 'fix-until-green.js', script: fixUntilGreen },
  { file: 'fix-issue.js', script: fixIssue },
  { file: 'bug-hunt.js', script: bugHunt },
  { file: 'security-audit.js', script: securityAudit },
  { file: 'design-panel.js', script: designPanel },
  { file: 'ui-pass.js', script: uiPass },
  { file: 'migrate.js', script: migrate },
  { file: 'compare-harnesses.js', script: compareHarnesses },
];
