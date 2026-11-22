export type Role = 'owner' | 'cashier' | 'worker' | 'customer';
export type Lang = 'en' | 'hi' | 'mr';

export interface Profile {
  id: string;
  phone: string;
  full_name: string;
  role: Role;
  active: boolean;
  lang: Lang;
  created_at: string;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  cashier: 'Cashier',
  worker: 'Worker',
  customer: 'Customer',
};
