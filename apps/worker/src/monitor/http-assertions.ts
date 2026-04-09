export const HTTP_RESPONSE_MATCH_MODES = ['contains', 'regex'] as const;

export type HttpResponseMatchMode = (typeof HTTP_RESPONSE_MATCH_MODES)[number];

type AssertionKind = 'required' | 'forbidden';
type AssertionField = 'response_keyword' | 'response_forbidden_keyword';
type AssertionModeField = 'response_keyword_mode' | 'response_forbidden_keyword_mode';

type AssertionValidationInput = {
  value: string | null | undefined;
  mode: HttpResponseMatchMode | null | undefined;
  valueField: AssertionField;
  modeField: AssertionModeField;
};

export type HttpResponseAssertionValidationIssue = {
  path: [AssertionField | AssertionModeField];
  message: string;
};

export type PreparedHttpResponseAssertion = {
  kind: AssertionKind;
  mode: HttpResponseMatchMode;
  value: string;
  test: (text: string) => boolean;
};

export function normalizeHttpResponseMatchMode(
  mode: HttpResponseMatchMode | null | undefined,
): HttpResponseMatchMode {
  return mode ?? 'contains';
}

export function getRegexPatternError(pattern: string): string | null {
  try {
    void new RegExp(pattern);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function validateAssertionPair(
  input: AssertionValidationInput,
): HttpResponseAssertionValidationIssue[] {
  const { value, mode, valueField, modeField } = input;
  if (mode !== undefined && mode !== null && (value === undefined || value === null)) {
    return [
      {
        path: [modeField],
        message: `${modeField} requires ${valueField}`,
      },
    ];
  }

  if (typeof value !== 'string' || normalizeHttpResponseMatchMode(mode) !== 'regex') {
    return [];
  }

  const regexError = getRegexPatternError(value);
  if (!regexError) {
    return [];
  }

  return [
    {
      path: [valueField],
      message: `Invalid regex for ${valueField}: ${regexError}`,
    },
  ];
}

export function validateHttpResponseAssertionConfig(input: {
  responseKeyword: string | null | undefined;
  responseKeywordMode: HttpResponseMatchMode | null | undefined;
  responseForbiddenKeyword: string | null | undefined;
  responseForbiddenKeywordMode: HttpResponseMatchMode | null | undefined;
}): HttpResponseAssertionValidationIssue[] {
  return [
    ...validateAssertionPair({
      value: input.responseKeyword,
      mode: input.responseKeywordMode,
      valueField: 'response_keyword',
      modeField: 'response_keyword_mode',
    }),
    ...validateAssertionPair({
      value: input.responseForbiddenKeyword,
      mode: input.responseForbiddenKeywordMode,
      valueField: 'response_forbidden_keyword',
      modeField: 'response_forbidden_keyword_mode',
    }),
  ];
}

function compileAssertionMatcher(
  value: string,
  mode: HttpResponseMatchMode,
): { ok: true; test: (text: string) => boolean } | { ok: false; error: string } {
  if (mode === 'contains') {
    return {
      ok: true,
      test: (text) => text.includes(value),
    };
  }

  try {
    const regex = new RegExp(value);
    return {
      ok: true,
      test: (text) => regex.test(text),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: detail,
    };
  }
}

export function prepareHttpResponseAssertions(input: {
  responseKeyword: string | null | undefined;
  responseKeywordMode: HttpResponseMatchMode | null | undefined;
  responseForbiddenKeyword: string | null | undefined;
  responseForbiddenKeywordMode: HttpResponseMatchMode | null | undefined;
}):
  | { ok: true; assertions: PreparedHttpResponseAssertion[] }
  | { ok: false; error: string } {
  const validationIssues = validateHttpResponseAssertionConfig(input);
  if (validationIssues.length > 0) {
    return { ok: false, error: validationIssues[0]!.message };
  }

  const assertions: PreparedHttpResponseAssertion[] = [];

  const pairs: Array<{
    value: string | null | undefined;
    mode: HttpResponseMatchMode | null | undefined;
    kind: AssertionKind;
    field: AssertionField;
  }> = [
    {
      value: input.responseKeyword,
      mode: input.responseKeywordMode,
      kind: 'required',
      field: 'response_keyword',
    },
    {
      value: input.responseForbiddenKeyword,
      mode: input.responseForbiddenKeywordMode,
      kind: 'forbidden',
      field: 'response_forbidden_keyword',
    },
  ];

  for (const pair of pairs) {
    if (typeof pair.value !== 'string') continue;

    const mode = normalizeHttpResponseMatchMode(pair.mode);
    const matcher = compileAssertionMatcher(pair.value, mode);
    if (!matcher.ok) {
      return {
        ok: false,
        error: `Invalid regex for ${pair.field}: ${matcher.error}`,
      };
    }

    assertions.push({
      kind: pair.kind,
      mode,
      value: pair.value,
      test: matcher.test,
    });
  }

  return { ok: true, assertions };
}

function assertionTruncationError(assertion: PreparedHttpResponseAssertion, maxBytes: number): string {
  if (assertion.kind === 'required') {
    return assertion.mode === 'regex'
      ? `Response body exceeded ${maxBytes} bytes; cannot assert required response regex`
      : `Response body exceeded ${maxBytes} bytes; cannot assert required keyword`;
  }

  return assertion.mode === 'regex'
    ? `Response body exceeded ${maxBytes} bytes; cannot assert forbidden response regex absence`
    : `Response body exceeded ${maxBytes} bytes; cannot assert forbidden keyword absence`;
}

function assertionMissError(assertion: PreparedHttpResponseAssertion): string {
  if (assertion.kind === 'required') {
    return assertion.mode === 'regex'
      ? 'Required response regex not matched'
      : 'Response keyword not found';
  }

  return assertion.mode === 'regex'
    ? 'Forbidden response regex matched'
    : 'Forbidden response keyword found';
}

export function evaluateHttpResponseAssertions(input: {
  assertions: PreparedHttpResponseAssertion[];
  text: string;
  truncated: boolean;
  maxBytes: number;
}): { status: 'up'; error: null } | { status: 'down' | 'unknown'; error: string } {
  const { assertions, text, truncated, maxBytes } = input;

  for (const assertion of assertions) {
    const matched = assertion.test(text);

    if (assertion.kind === 'required') {
      if (matched) continue;
      return {
        status: truncated ? 'unknown' : 'down',
        error: truncated
          ? assertionTruncationError(assertion, maxBytes)
          : assertionMissError(assertion),
      };
    }

    if (matched) {
      return {
        status: 'down',
        error: assertionMissError(assertion),
      };
    }

    if (truncated) {
      return {
        status: 'unknown',
        error: assertionTruncationError(assertion, maxBytes),
      };
    }
  }

  return { status: 'up', error: null };
}
