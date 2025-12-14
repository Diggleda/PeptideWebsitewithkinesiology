const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bwoocommerce\b/gi, 'store'],
  [/\bwoo\s*commerce\b/gi, 'store'],
  [/\bwoo\b/gi, 'store'],
  [/\bstripe\b/gi, 'payment provider'],
  [/\bcloudflare\b/gi, 'network provider'],
  [/\bgodaddy\b/gi, 'hosting provider'],
  [/\bshipstation\b/gi, 'shipping provider'],
  [/\bshipengine\b/gi, 'shipping provider'],
];

export const sanitizeServiceNames = (input: string): string => {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }

  let output = input;
  for (const [pattern, replacement] of REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }

  // Clean up common double-words after replacements.
  output = output.replace(/\bstore\s+store\b/gi, 'store');
  output = output.replace(/\bpayment provider\s+payment provider\b/gi, 'payment provider');

  return output;
};

const MESSAGE_KEYS = new Set([
  'error',
  'message',
  'reason',
  'hint',
  'title',
  'statusText',
  'detail',
]);

export const sanitizePayloadMessages = <T>(payload: T): T => {
  const visited = new WeakSet<object>();

  const walk = (value: any, parentKey: string | null): any => {
    if (typeof value === 'string') {
      if (parentKey && MESSAGE_KEYS.has(parentKey)) {
        return sanitizeServiceNames(value);
      }
      return value;
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    if (visited.has(value)) {
      return value;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        value[i] = walk(value[i], parentKey);
      }
      return value;
    }

    for (const [key, child] of Object.entries(value)) {
      value[key] = walk(child, key);
    }
    return value;
  };

  return walk(payload, null);
};

