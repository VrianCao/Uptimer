export const APP_NAME = 'Uptimer';

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value.trim().length > 0;
  } catch {
    return false;
  }
}
