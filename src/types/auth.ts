export type AuthActionResult =
  | { status: 'success' }
  | { status: 'email_not_found' }
  | { status: 'invalid_password' }
  | { status: 'email_exists' }
  | { status: 'error'; message: string };
