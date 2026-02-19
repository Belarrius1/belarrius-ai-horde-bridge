const CSAM_FILTER = [
  /\bcsam\b/i,
  /\bcsem\b/i,
  /\bchild\s+sexual\s+abuse\s+material\b/i,
  /\bchild\s+porn(?:ography)?\b/i,
  /\bpedoporn(?:ography|ographique)?\b/i,
  /\blolicon\b/i,
  /\bshotacon\b/i,
  /\bunderage\s+(?:porn|sex|sexual|naked|nude)\b/i,
  /\bpreteen(?:s)?\s+(?:porn|sex|sexual|naked|nude)\b/i,
  /\b(child|kid|enfant|mineur)\s+(?:porn|sex|sexual|naked|nude|fuck|rape)\b/i,
  /\b(enfant|fillette|gar(?:c|\u00E7)onnet|mineur)\s+(?:sexuel|sexuelle|viol|baise)\b/i
];

export function isCsamPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return false;
  }
  return CSAM_FILTER.some((regex) => regex.test(prompt));
}
