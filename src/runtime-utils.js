import fs from 'fs';

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function logPromptForAudit({ outputPromptFile, jobId, prompt, logger }) {
  if (!outputPromptFile) return;

  const timestamp = new Date().toISOString();
  const safePrompt = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  const entry = `[${timestamp}] job=${jobId}\n${safePrompt}\n\n`;

  try {
    fs.appendFileSync(outputPromptFile, entry, 'utf8');
  } catch (error) {
    logger.error(`Failed writing prompt log to ${outputPromptFile}: ${error.message}`);
  }
}

export function logCsamTriggerForAudit({
  logFile,
  jobId,
  reason,
  mode,
  threshold = null,
  openaiMinorScore = null,
  prompt
}) {
  if (!logFile) return;

  const entry = {
    ts: new Date().toISOString(),
    event: 'CSAM_TRIGGER',
    jobId,
    reason,
    mode,
    threshold,
    openaiMinorScore,
    promptLength: typeof prompt === 'string' ? prompt.length : null,
    prompt: typeof prompt === 'string' ? prompt : String(prompt ?? '')
  };

  try {
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Silent by design: avoid polluting console/UI on audit write failures.
  }
}
