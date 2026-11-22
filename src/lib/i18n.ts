import type { Lang } from './types';

// All screen text lives here so Hindi / Marathi can be added later
// by filling in the `hi` and `mr` objects. Missing keys fall back to English.
const en = {
  appName: 'Mushroom Farm',
  login: 'Log in',
  logout: 'Log out',
  mobile: 'Mobile number',
  password: 'Password',
  loggingIn: 'Logging in…',
  badLogin: 'Wrong mobile number or password.',
  badPhone: 'Enter a valid 10-digit mobile number.',
  accountDisabled: 'This account is disabled. Please contact the owner.',
  noProfile: 'This login is not set up yet. Please contact the owner.',
  profileError: 'Logged in, but the app could not load your account. Check the database setup.',
  forgot: 'Forgot password? Ask the owner to reset it.',
  home: 'Home',
  users: 'Users',
  profile: 'My account',
  hello: 'Hello',
  comingSoon: 'Coming soon',
  save: 'Save',
  cancel: 'Cancel',
  language: 'Language',
  changePassword: 'Change password',
  newPassword: 'New password',
  confirmPassword: 'Confirm new password',
  passwordsDiffer: 'The two passwords do not match.',
  passwordShort: 'Password must be at least 6 characters.',
  saved: 'Saved.',
};

export type TKey = keyof typeof en;

const dict: Record<Lang, Partial<Record<TKey, string>>> = {
  en,
  hi: {},
  mr: {},
};

let current: Lang = 'en';
export function setLang(l: Lang) {
  current = l;
}
export function t(key: TKey): string {
  return dict[current][key] ?? en[key];
}
